require("dotenv").config();
const fetch = require("node-fetch");

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

if (!OPENROUTER_API_KEY) {
  throw new Error("OPENROUTER_API_KEY is missing in your .env file!");
}

console.log("Key loaded:", OPENROUTER_API_KEY ? "YES" : "NO");

const SYSTEM_PROMPT = `
Your job is to analyze user input and return ONLY a valid JSON object.

You MUST classify the request into ONE of the following intents:

1. ACTIONS (when user wants to DO something)

OPEN REPOSITORY
{ "intent": "open", "url": "<github url or owner/repo>" }

CLONE REPOSITORY
{ "intent": "clone", "repo": "<owner/repo or url>", "folder": "<local folder path>" }

CREATE REPOSITORY
{ "intent": "create", "repoName": "<name>", "description": "<desc or empty string>" }

PUSH CODE
{ "intent": "push", "folder": "<local folder>", "repo": "<owner/repo or url>", "message": "<commit message>" }

2. SEMANTIC SEARCH (when user wants to UNDERSTAND something)

SEARCH
{ "intent": "search", "query": "<cleaned semantic query>" }

Use SEARCH when:
- user asks "how", "where", "why", "explain", "find"
- user is asking about code, logic, features, bugs
- user wants understanding, not execution

3. EXIT

{ "intent": "exit" }

4. UNKNOWN

{ "intent": "unknown", "reason": "<why unclear>" }

STRICT RULES:
- Return ONLY raw JSON (no markdown, no explanation)
- NEVER include triple backticks or any extra text
- NEVER hallucinate repo names or URLs
- If user asks a QUESTION, ALWAYS use intent = "search"
- If user asks an ACTION, use corresponding action intent
- If both exist, PRIORITIZE ACTION
- Clean the search query:
  - remove filler words
  - keep technical meaning
  - make it short and precise

DEFAULTS:
- clone folder -> "."
- push message -> "Update via RepoRover"
- description -> ""
`;

async function parseIntent(userInput) {
  console.log("Calling OpenRouter with openrouter/auto...");

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://reporover.local",
      "X-Title": "RepoRover GitHub Assistant",
    },
    body: JSON.stringify({
      model: "openrouter/auto",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userInput },
      ],
      temperature: 0.1,
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(JSON.stringify(data));
  }

  console.log("Model used:", data.model);

  const raw = data.choices?.[0]?.message?.content?.trim() || "";
  console.log("Raw response:", raw);

  const cleaned = raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/g, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    console.error("Could not parse as JSON:", cleaned);
    return { intent: "unknown", reason: "LLM returned non-JSON output" };
  }
}

module.exports = { parseIntent };
