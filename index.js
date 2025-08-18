const puppeteer = require("puppeteer");
const dotenv = require("dotenv");
const readline = require("readline");
const { exec } = require("child_process");
const fetch = require("node-fetch");

dotenv.config();

let GITHUB_EMAIL = process.env.GITHUB_EMAIL?.trim();
let GITHUB_PASSWORD = process.env.GITHUB_PASSWORD?.trim();
let GITHUB_TOKEN = process.env.GITHUB_TOKEN?.trim();
let GITHUB_USERNAME = process.env.GITHUB_USERNAME?.trim();

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
  if (input.startsWith("http")) return input;
  if (input.includes("/") && !input.includes(" ")) {
    return `https://github.com/${input}.git`;
  }
  return input;
}

async function handleClone(repoInput, targetDir) {
  if (!repoInput) {
    console.log("⚠️ Please specify a repository (owner/repo or full URL).");
    return;
  }
  const repoUrl = normalizeRepo(repoInput);

  console.log(`📦 Cloning from: ${repoUrl}`);
  console.log(`📂 Target directory: ${targetDir}`);

  exec(`git clone ${repoUrl} "${targetDir}"`, (error, stdout, stderr) => {
    if (error) {
      console.error(`❌ Clone failed: ${stderr}`);
      return;
    }
    if (stderr) console.error(`⚠️ Warning: ${stderr}`);
    console.log(`✅ Clone successful! Repo is in: ${targetDir}`);
  });
}

async function handlePush(folderPath, repoInput, commitMessage) {
  if (!GITHUB_TOKEN || !GITHUB_USERNAME) {
    console.log("❌ GITHUB_TOKEN and GITHUB_USERNAME required in .env");
    return;
  }

  commitMessage = commitMessage || "Update via Eva";

  // Normalize repo URL
  let repoUrl = normalizeRepo(repoInput);
  if (!repoUrl.endsWith(".git")) repoUrl += ".git";

  // Insert token for HTTPS authentication
  repoUrl = repoUrl.replace(
    "https://",
    `https://${GITHUB_USERNAME}:${GITHUB_TOKEN}@`
  );

  console.log(`🚀 Pushing from ${folderPath} → ${repoUrl}`);

  const commands = `
    cd "${folderPath}" &&
    git remote remove origin 2>/dev/null || true &&
    git remote add origin "${repoUrl}" &&
    git add . &&
    if git diff --cached --quiet; then
      echo "⚠️ Nothing new to commit, skipping push";
    else
      git commit -m "${commitMessage}";
      git branch -M main;
      git push -u origin main;
    fi
  `;

  exec(commands, (error, stdout, stderr) => {
    console.log("----- Git Output -----");
    console.log(stdout);
    console.error(stderr);
    console.log("----------------------");

    if (error) {
      console.error(`❌ Push failed: ${stderr}`);
      return;
    }
    console.log("✅ Push completed! Refresh GitHub to check changes.");
  });
}


async function interactiveMode(page) {
  while (true) {
    const command = await askQuestion("🤖 What do you want to do next? ");

    if (command.toLowerCase().startsWith("open ")) {
      const urlPart = command.split("open ")[1];
      const url = urlPart.startsWith("http")
        ? urlPart
        : `https://github.com/${urlPart}`;
      console.log(`🌍 Navigating to ${url}...`);
      await page.goto(url, { waitUntil: "networkidle2" });

    } else if (command.toLowerCase().startsWith("clone ")) {
      const parts = command.split(" ");
      if (parts.length >= 3) {
        const repo = parts[1];
        const folderPath = parts.slice(2).join(" ");
        await handleClone(repo, folderPath);
      } else {
        console.log("❌ Usage: clone <repo-url-or-owner/repo> <folder-path>");
      }

    } else if (command.toLowerCase().startsWith("create ")) {
      const parts = command.split(" ");
      const repoName = parts[1];
      const description = parts.slice(2).join(" ");
      await handleCreate(repoName, description);

    } else if (command.toLowerCase().startsWith("push ")) {
      const parts = command.split(" ");
      if (parts.length >= 4) {
        const folderPath = parts[1];
        const repo = parts[2];
        const commitMessage = command.split('"')[1] || "Update via Eva";
        await handlePush(folderPath, repo, commitMessage);
      } else {
        console.log(
          `❌ Usage: push <folder-path> <repo-url-or-owner/repo> "commit message"`
        );
      }

    } else if (command.toLowerCase() === "exit") {
      console.log("👋 Exiting Eva Assistant...");
      await page.browser().close();
      process.exit(0);

    } else {
      console.log(
        "⚠️ Unknown command. Try 'open <url>', 'clone <repo> <folder>', 'create <repo> <desc>', 'push <folder> <repo> \"commit msg\"', or 'exit'."
      );
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "clone") {
    await handleClone(args[1], args[2] || ".");
    return;
  }

  if (!GITHUB_EMAIL) throw new Error("❌ GITHUB_EMAIL is missing in .env file");
  if (!GITHUB_PASSWORD) {
    console.log("⚠️ GITHUB_PASSWORD missing in .env. Please enter it now:");
    GITHUB_PASSWORD = await askQuestion("Password: ");
  }

  console.log("🚀 Starting Eva Assistant...");

  const browser = await puppeteer.launch({ headless: false });
  const page = await browser.newPage();

  console.log("🌐 Opening GitHub login...");
  await page.goto("https://github.com/");
  await page.goto("https://github.com/login", { waitUntil: "networkidle2" });

  console.log("🔑 Typing credentials...");
  await page.type("#login_field", GITHUB_EMAIL, { delay: 100 });
  await page.type("#password", GITHUB_PASSWORD, { delay: 100 });
  await page.click('input[name="commit"]');
  await page.waitForNavigation({ waitUntil: "networkidle2" });

  console.log("✅ Signed in to GitHub!");

  await interactiveMode(page);
}

main().catch((err) => console.error("❌ Error:", err));
