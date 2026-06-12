// One-time registration of the bot's global commands as USER-installable.
// Run: npm run register   (reads .dev.vars or process.env)
import { existsSync, readFileSync } from "node:fs";

// Load .dev.vars (KEY=value lines) into process.env if present.
if (existsSync(".dev.vars")) {
  for (const line of readFileSync(".dev.vars", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

const APP_ID = process.env.DISCORD_APP_ID;
const TOKEN = process.env.DISCORD_BOT_TOKEN;
if (!APP_ID || !TOKEN) {
  console.error("Set DISCORD_APP_ID and DISCORD_BOT_TOKEN (in .dev.vars or env).");
  process.exit(1);
}

// integration_types: [1] = USER_INSTALL only
// contexts: [0,1,2] = GUILD, BOT_DM, PRIVATE_CHANNEL (everywhere)
const commands = [
  {
    name: "Translate",
    type: 3, // MESSAGE context menu
    integration_types: [1],
    contexts: [0, 1, 2],
  },
  {
    name: "translate",
    type: 1, // CHAT_INPUT slash
    description: "Translate text into a target language",
    options: [
      { name: "text", description: "Text to translate", type: 3, required: true },
      {
        name: "target",
        description: "Target language, e.g. English, Spanish (blank = default)",
        type: 3,
        required: false,
      },
    ],
    integration_types: [1],
    contexts: [0, 1, 2],
  },
];

const res = await fetch(`https://discord.com/api/v10/applications/${APP_ID}/commands`, {
  method: "PUT", // bulk overwrite all global commands
  headers: { Authorization: `Bot ${TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify(commands),
});

console.log("HTTP", res.status);
console.log(await res.text());

if (res.ok) {
  console.log("\nInstall to your account (user-install):");
  console.log(
    `https://discord.com/oauth2/authorize?client_id=${APP_ID}&integration_type=1&scope=applications.commands`,
  );
}
