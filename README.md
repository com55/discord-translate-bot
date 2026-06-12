# discord-translate-bot

A personal, serverless Discord bot that translates messages. Runs as a single
Cloudflare Worker. Installed to **your Discord account** (user-install), so it works
**everywhere** — any server, group DM, or DM.

Two entry points, both reply **ephemerally** (only you see the result):

- **Right-click a message → Apps → Translate** — translates any source language
  (English, Japanese, Chinese, …) to **Thai**. If the message is already Thai, it
  translates to English.
- **`/translate text:<draft> [target:English|Thai]`** — translate a draft before you
  send it. Default target is **English**.

Translation is done by `anthropic/claude-haiku-4.5` via OpenRouter by default, but
the provider is **configurable** — any OpenAI-compatible endpoint works (see below).

## Architecture

```
Discord ──POST /interactions──► Worker (src/index.ts)
  verify ed25519 → PING→PONG / route command
  → respond NOW: deferred ephemeral ack (beats Discord's 3s deadline)
  → ctx.waitUntil: translate() → PATCH .../messages/@original  (edit the reply in)
```

- `src/index.ts` — verify, route, defer, follow-up.
- `src/translate.ts` — the OpenRouter call.
- `scripts/register.ts` — one-time command registration (user-installable).

## Prerequisites

- A Discord application (https://discord.com/developers/applications). From it you need:
  - **Public Key** (General Information) → `DISCORD_PUBLIC_KEY`
  - **Application ID** → `DISCORD_APP_ID`
  - **Bot token** (Bot tab) → `DISCORD_BOT_TOKEN` (used only to register commands)
- An API key for your LLM provider → `LLM_API_KEY` (default provider: OpenRouter,
  https://openrouter.ai/keys)
- A Cloudflare account (`npx wrangler login`).

## Setup

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in all four values
```

### 1. Register the commands (one-time, and after any command change)

```bash
npm run register
```

This prints an **install URL**. Open it and authorize — that adds the app to your
account so the commands follow you everywhere.

### 2. Deploy the Worker

```bash
npx wrangler login        # once
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put DISCORD_APP_ID
npx wrangler secret put LLM_API_KEY
npx wrangler deploy
```

`wrangler deploy` prints the Worker URL, e.g. `https://discord-translate-bot.<acct>.workers.dev`.

### 3. Point Discord at the Worker

In the Discord Developer Portal → your app → **General Information** →
**Interactions Endpoint URL**, set it to the Worker URL and save. Discord sends a
PING; the Worker answers PONG and the URL is accepted.

## Choosing a provider

Translation calls any **OpenAI-compatible** `/chat/completions` endpoint. Set the
base URL and model in `wrangler.jsonc` under `vars` (non-secret), and the key as the
`LLM_API_KEY` secret:

| Provider | `LLM_BASE_URL` | example `LLM_MODEL` |
|----------|----------------|---------------------|
| OpenRouter (default) | `https://openrouter.ai/api/v1` | `anthropic/claude-haiku-4.5` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| Groq | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` |
| Local Ollama | `http://localhost:11434/v1` | `qwen2.5` |

After editing `vars`, redeploy (`npx wrangler deploy`). Locally, override in `.dev.vars`.

## Use

- Right-click any message → **Apps → Translate** → ephemeral Thai (or English) reply.
- `/translate text:<your draft>` → ephemeral English; add `target:Thai` to flip.

## Develop / test

```bash
npm test          # vitest unit tests (routing, defer, translate prompts)
npm run typecheck # tsc on the Worker + tests
npm run dev       # local wrangler dev (needs .dev.vars)
```

> Local interaction testing needs a public tunnel (e.g. `cloudflared tunnel`) pointed
> at `wrangler dev`, since Discord must reach the endpoint. Easiest path is to deploy
> and test against the live Worker.
