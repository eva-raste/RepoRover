const puppeteer = require("puppeteer");
const dotenv = require("dotenv");
const readline = require("readline");
const { exec } = require("child_process");
const { parseIntent } = require("./semantic");

dotenv.config();

let GITHUB_EMAIL = process.env.GITHUB_EMAIL?.trim();
let GITHUB_PASSWORD = process.env.GITHUB_PASSWORD?.trim();
let GITHUB_TOKEN = process.env.GITHUB_TOKEN?.trim();
let GITHUB_USERNAME = process.env.GITHUB_USERNAME?.trim();
let voicePagePromise = null;

function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) =>
    rl.question(query, (ans) => {
      rl.close();
      resolve(ans.trim());
    })
  );
}

function normalizeRepo(input) {
  const trimmed = input?.trim();
  if (!trimmed) return trimmed;

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed.endsWith(".git") ? trimmed : `${trimmed}.git`;
  }

  if (trimmed.startsWith("github.com/")) {
    return `https://${trimmed.endsWith(".git") ? trimmed : `${trimmed}.git`}`;
  }

  if (trimmed.includes("/") && !trimmed.includes(" ")) {
    return `https://github.com/${trimmed.endsWith(".git") ? trimmed : `${trimmed}.git`}`;
  }

  return trimmed;
}

function withGitCredentials(repoUrl) {
  if (!repoUrl?.startsWith("https://")) return repoUrl;
  if (!GITHUB_TOKEN || !GITHUB_USERNAME) return repoUrl;

  const encodedUsername = encodeURIComponent(GITHUB_USERNAME);
  const encodedToken = encodeURIComponent(GITHUB_TOKEN);

  return repoUrl.replace(
    "https://",
    `https://${encodedUsername}:${encodedToken}@`
  );
}

function runCommand(command, options = {}) {
  return new Promise((resolve) => {
    exec(command, options, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        error,
        stdout: stdout?.trim() || "",
        stderr: stderr?.trim() || "",
      });
    });
  });
}

async function ensureVoicePage(browser) {
  if (!voicePagePromise) {
    voicePagePromise = (async () => {
      const voicePage = await browser.newPage();
      await gotoWithRetry(voicePage, "https://example.com/");
      return voicePage;
    })().catch((error) => {
      voicePagePromise = null;
      throw error;
    });
  }

  return voicePagePromise;
}

async function captureVoiceCommand(browser) {
  const voicePage = await ensureVoicePage(browser);
  await gotoWithRetry(voicePage, "https://example.com/");
  await voicePage.bringToFront();
  console.log("Voice mode: start speaking after the browser tab comes into focus.");

  await voicePage.addScriptTag({
    content: `
      (() => {
        const existing = document.getElementById("voice-result");
        if (existing) existing.remove();

        const result = document.createElement("textarea");
        result.id = "voice-result";
        result.setAttribute("data-state", "starting");
        result.style.position = "fixed";
        result.style.left = "16px";
        result.style.top = "16px";
        result.style.width = "420px";
        result.style.height = "120px";
        result.style.zIndex = "999999";
        document.body.appendChild(result);

        const SpeechRecognition =
          window.SpeechRecognition || window.webkitSpeechRecognition;

        if (!SpeechRecognition) {
          result.value = "unsupported";
          result.setAttribute("data-state", "unsupported");
          return;
        }

        let finalTranscript = "";
        const recognition = new SpeechRecognition();
        recognition.lang = "en-US";
        recognition.continuous = false;
        recognition.interimResults = true;
        recognition.maxAlternatives = 1;
        result.setAttribute("data-state", "listening");

        recognition.onresult = (event) => {
          let combined = "";
          for (let i = event.resultIndex; i < event.results.length; i += 1) {
            combined += event.results[i][0].transcript;
            if (event.results[i].isFinal) {
              finalTranscript += event.results[i][0].transcript + " ";
            }
          }
          result.value = (finalTranscript || combined).trim();
        };

        recognition.onerror = (event) => {
          result.value = event.error || "unknown";
          result.setAttribute("data-state", "error");
        };

        recognition.onend = () => {
          if (result.getAttribute("data-state") !== "error") {
            result.setAttribute("data-state", "done");
          }
          result.value = result.value.trim();
        };

        try {
          recognition.start();
        } catch (error) {
          result.value = error.message || "start_failed";
          result.setAttribute("data-state", "error");
          return;
        }

        setTimeout(() => {
          try {
            recognition.stop();
          } catch (error) {
            result.value = error.message || "stop_failed";
            result.setAttribute("data-state", "error");
          }
        }, 12000);
      })();
    `,
  });

  await voicePage.waitForSelector(
    '#voice-result[data-state="done"], #voice-result[data-state="unsupported"], #voice-result[data-state="error"]',
    { timeout: 15000 }
  );

  const html = await voicePage.content();
  const stateMatch = html.match(/id="voice-result"[^>]*data-state="([^"]+)"/i);
  const valueMatch = html.match(/<textarea id="voice-result"[^>]*>([\s\S]*?)<\/textarea>/i);
  const state = stateMatch?.[1] || "";
  const transcript = (valueMatch?.[1] || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .trim();

  if (state === "unsupported") {
    console.log("Voice input is not supported by this browser profile.");
    return "";
  }

  if (state === "error") {
    console.log(`Voice capture failed: ${transcript || "unknown"}`);
    return "";
  }

  return transcript.trim();
}

async function promptForCommand(browser) {
  const typedInput = await askQuestion(
    "\nWhat do you want to do? (Press Enter for voice) "
  );

  if (typedInput) {
    return typedInput;
  }

  let spokenInput = "";
  try {
    spokenInput = await captureVoiceCommand(browser);
  } catch (error) {
    console.error(`Voice capture failed: ${error.message}`);
    return "";
  }

  if (!spokenInput) {
    console.log("I did not catch any speech. Try again or type your command.");
    return "";
  }

  console.log(`Heard: ${spokenInput}`);
  const confirmation = await askQuestion(
    "Press Enter to execute this, or type a replacement: "
  );
  return confirmation || spokenInput;
}

async function handleClone(repoInput, targetDir) {
  if (!repoInput) {
    console.log("Please specify a repository (owner/repo or full URL).");
    return false;
  }

  let repoUrl = normalizeRepo(repoInput);
  if (GITHUB_TOKEN && GITHUB_USERNAME) {
    repoUrl = withGitCredentials(repoUrl);
  } else {
    console.log("GITHUB_TOKEN or GITHUB_USERNAME missing in .env - clone may fail for private repos.");
  }

  const safeTarget = (targetDir || ".").replace(/\\/g, "/");
  console.log(`Cloning into: ${safeTarget}`);

  const result = await runCommand(`git clone "${repoUrl}" "${safeTarget}"`, {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });

  if (!result.ok) {
    const details = result.stderr || result.error?.message || "Unknown git error";
    if (/repository .* not found/i.test(details)) {
      console.error(
        `Clone failed: GitHub could not find "${repoInput}". Check the owner/repo name or your access permissions.`
      );
    } else {
      console.error(`Clone failed: ${details}`);
    }
    return false;
  }

  if (result.stderr) console.log(`Git info: ${result.stderr}`);
  if (result.stdout) console.log(result.stdout);
  console.log(`Clone successful! Repo is in: ${safeTarget}`);
  return true;
}

async function handlePush(folderPath, repoInput, commitMessage) {
  if (!GITHUB_TOKEN || !GITHUB_USERNAME) {
    console.log("GITHUB_TOKEN and GITHUB_USERNAME required in .env");
    return false;
  }

  commitMessage = commitMessage || "Update via RepoRover";

  let repoUrl = normalizeRepo(repoInput);
  repoUrl = withGitCredentials(repoUrl);

  console.log(`Pushing from ${folderPath} -> ${repoUrl}`);

  const commands = `
    cd "${folderPath}" &&
    git remote remove origin 2>/dev/null || true &&
    git remote add origin "${repoUrl}" &&
    git add . &&
    if git diff --cached --quiet; then
      echo "Nothing new to commit, skipping push";
    else
      git commit -m "${commitMessage}";
      git branch -M main;
      git push -u origin main;
    fi
  `;

  const result = await runCommand(commands);

  console.log("----- Git Output -----");
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  console.log("----------------------");

  if (!result.ok) {
    console.error(`Push failed: ${result.stderr || result.error?.message || "Unknown git error"}`);
    return false;
  }

  console.log("Push completed! Refresh GitHub to check changes.");
  return true;
}

async function handleCreate(repoName, description) {
  console.log(`Create is not implemented yet for repo "${repoName}"${description ? ` (${description})` : ""}.`);
  return false;
}

async function gotoWithRetry(page, url, options = {}) {
  const finalOptions = {
    waitUntil: "domcontentloaded",
    timeout: 60000,
    ...options,
  };

  try {
    await page.goto(url, finalOptions);
    return true;
  } catch (error) {
    console.error(`Navigation warning for ${url}: ${error.message}`);
    return false;
  }
}

async function handleSearch(page, query) {
  if (!query) {
    console.log("Could not determine what to search for.");
    return false;
  }

  const searchUrl = `https://github.com/search?q=${encodeURIComponent(query)}&type=code`;
  console.log(`Searching GitHub for: ${query}`);
  await page.goto(searchUrl, { waitUntil: "networkidle2" });
  return true;
}

async function interactiveMode(page) {
  while (true) {
    const userInput = await promptForCommand(page.browser());
    if (!userInput) {
      continue;
    }

    let parsed;
    try {
      console.log("Thinking...");
      parsed = await parseIntent(userInput);
    } catch (err) {
      console.error("Semantic parsing failed:", err.message);
      continue;
    }

    console.log("Understood intent:", JSON.stringify(parsed, null, 2));

    switch (parsed.intent) {
      case "open": {
        const url = parsed.url.startsWith("http")
          ? parsed.url
          : `https://github.com/${parsed.url}`;
        console.log(`Navigating to ${url}...`);
        await page.goto(url, { waitUntil: "networkidle2" });
        break;
      }

      case "clone": {
        if (!parsed.repo) {
          console.log("Could not determine repo to clone.");
        } else {
          await handleClone(parsed.repo, parsed.folder || ".");
        }
        break;
      }

      case "create": {
        if (!parsed.repoName) {
          console.log("Could not determine repo name to create.");
        } else {
          await handleCreate(parsed.repoName, parsed.description || "");
        }
        break;
      }

      case "push": {
        if (!parsed.folder || !parsed.repo) {
          console.log("Could not determine folder or repo for push.");
        } else {
          await handlePush(parsed.folder, parsed.repo, parsed.message);
        }
        break;
      }

      case "search": {
        await handleSearch(page, parsed.query);
        break;
      }

      case "exit": {
        console.log("Exiting RepoRover...");
        await page.browser().close();
        process.exit(0);
      }

      case "unknown":
      default: {
        console.log(`Could not understand: ${parsed.reason || "Unknown reason"}`);
        console.log('Try: "clone torvalds/linux into /tmp/linux" or "push my folder to myuser/myrepo with message fix bugs"');
      }
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "clone") {
    await handleClone(args[1], args[2] || ".");
    return;
  }

  if (!GITHUB_EMAIL) throw new Error("GITHUB_EMAIL is missing in .env file");
  if (!GITHUB_PASSWORD) {
    console.log("GITHUB_PASSWORD missing in .env. Please enter it now:");
    GITHUB_PASSWORD = await askQuestion("Password: ");
  }

  console.log("Starting RepoRover...");

  const browser = await puppeteer.launch({
    headless: false,
    args: ["--use-fake-ui-for-media-stream"],
  });
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(60000);

  console.log("Opening GitHub login...");
  await gotoWithRetry(page, "https://github.com/");
  const openedLogin = await gotoWithRetry(page, "https://github.com/login");
  if (!openedLogin) {
    throw new Error("Could not open GitHub login page.");
  }
  await page.waitForSelector("#login_field", { timeout: 60000 });

  console.log("Typing credentials...");
  await page.type("#login_field", GITHUB_EMAIL, { delay: 100 });
  await page.type("#password", GITHUB_PASSWORD, { delay: 100 });
  await page.click('input[name="commit"]');
  await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 });

  console.log("Signed in to GitHub!");
  await interactiveMode(page);
}

main().catch((err) => console.error("Error:", err));
