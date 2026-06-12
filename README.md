# discord-translate-bot

A personal, serverless Discord translation bot. Runs as a single Cloudflare Worker and
installs to **your Discord account** (user-install), so it works **everywhere** — any
server, group DM, or DM, even where the bot isn't a member. All replies are
**ephemeral** (only you see them).

- **Right-click a message → Apps → Translate** — auto-detects the source and translates
  it into your primary language. (If the message is already in the primary language, it
  flips to the secondary one.) The result has a **✍️ Translate a reply** button.
- **✍️ Translate a reply** (button on the result) — opens a modal where you type a reply;
  the bot translates it *using the original message as context*, so the wording fits the
  conversation. Defaults to the original message's language, or pick any target.
- **`/translate text:<draft> [target:<language>]`** — translate your own draft before
  sending. `target` is any language; blank uses the secondary language.

Both the **language pair** and the **LLM provider** are configurable (see below). Default:
Thai ⇄ English, translated by `anthropic/claude-haiku-4.5` via OpenRouter.

## Architecture

```
Discord ──POST /interactions──► Worker (src/index.ts)
  verify ed25519 → route (command / button / modal)
  → respond NOW: deferred ephemeral ack (beats Discord's 3s deadline)
  → ctx.waitUntil: translate → PATCH .../messages/@original  (edit the reply in)
```

- `src/index.ts` — verify, route, defer, follow-up; the reply button + modal.
- `src/translate.ts` — the LLM calls (auto / explicit target / context-aware reply).
- `scripts/register.ts` — one-time command registration (user-installable).

No database: the original message is carried statelessly through the result text
(`> -# subtext`) and a context field in the reply modal.

## Prerequisites

- A Discord application — https://discord.com/developers/applications. You'll need its
  **Public Key** and **Application ID** (General Information) and a **Bot token** (Bot tab,
  used only to register commands). Under **Installation**, make sure **User Install** is
  enabled.
- An API key for an **OpenAI-compatible** LLM provider (default: OpenRouter —
  https://openrouter.ai/keys).
- A Cloudflare account (`npx wrangler login`).

## Setup

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in DISCORD_PUBLIC_KEY, DISCORD_APP_ID,
                                 # LLM_API_KEY, DISCORD_BOT_TOKEN
```

### 1. Register the commands (one-time, and after any command change)

```bash
npm run register
```

Prints an **install URL** — open it and authorize to add the app to your account.

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

Discord Developer Portal → your app → **General Information** → **Interactions Endpoint
URL** → paste the Worker URL and save. Discord sends a PING; the Worker answers PONG and
the URL is accepted.

## Configuration

Non-secret settings live in `wrangler.jsonc` under `vars`; the API key is a secret. Edit
`vars` then redeploy (`npx wrangler deploy`); override locally in `.dev.vars`.

| Var | Default | Meaning |
|-----|---------|---------|
| `PRIMARY_LANG` | `Thai` | Context-menu translates any source into this language |
| `SECONDARY_LANG` | `English` | A primary-language message flips to this; also the `/translate` default target |
| `LLM_BASE_URL` | `https://openrouter.ai/api/v1` | OpenAI-compatible `/chat/completions` base |
| `LLM_MODEL` | `anthropic/claude-haiku-4.5` | Model id |
| `LLM_API_KEY` (secret) | — | Provider API key |

Use full English language names (e.g. `Spanish`, `Japanese`). Any OpenAI-compatible
provider works by swapping the base URL + model:

| Provider | `LLM_BASE_URL` | example `LLM_MODEL` |
|----------|----------------|---------------------|
| OpenRouter (default) | `https://openrouter.ai/api/v1` | `anthropic/claude-haiku-4.5` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| Groq | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` |
| Local Ollama | `http://localhost:11434/v1` | `qwen2.5` |

## Develop / test

```bash
npm test          # vitest unit tests (routing, defer, reply flow, prompts)
npm run typecheck # tsc on the Worker + tests
npm run dev       # local wrangler dev (needs .dev.vars)
```

> Local interaction testing needs a public tunnel (e.g. `cloudflared tunnel`) pointed at
> `wrangler dev`, since Discord must reach the endpoint. Deploying and testing against the
> live Worker is usually easier.

## License

MIT — see [LICENSE](LICENSE).
