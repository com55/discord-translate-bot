# Personal Discord Translate Bot — Design

**Date:** 2026-06-13
**Status:** Approved (brainstorming)
**Author:** com55

## Purpose

A single-user, serverless Discord bot that translates messages between Thai and
English. Two entry points:

1. **Message context menu "Translate"** — right-click any message → Apps →
   Translate. Primary target is **Thai**: the LLM auto-detects the source language
   (English, Japanese, Chinese, etc.) and translates it to Thai. If the message is
   already Thai, it translates to English instead (so the command never no-ops).
   Reply is ephemeral (only the invoker sees it).
2. **`/translate` slash command** — translate a draft *before* sending it. Takes
   the text plus an optional target language (choices: English, Thai; **default
   English**). Reply is ephemeral, so the user copies it and sends it themselves.

Installed to the user's Discord **account** (user-install), so both commands work
**everywhere** — any server, group DM, or DM, including servers where the bot is
not a member.

## Non-goals (YAGNI)

- No translation cache (KV/DB). Personal volume; every invocation is a fresh call.
- No persistent state of any kind — the Worker is fully stateless.
- No languages beyond Thai/English in the slash command choices (easy to add later).
- No guild-install / server membership management.

## Architecture

Single **Cloudflare Worker** (TypeScript), deployed to the Singapore edge. Chosen
to match the existing RoleBot PoC stack (~0.3 ms cold start, ~40 ms RTT from the
Pi, free tier) and, critically, to reuse the proven pattern for beating Discord's
**3-second interaction deadline**: respond immediately with a *deferred* ACK, then
do the slow translation in `ctx.waitUntil` and edit the reply in via webhook.

An OpenRouter → Claude Haiku call takes ~1–3 s, so deferring is mandatory, not an
optimization.

### Translation engine

OpenRouter `/chat/completions`, model `anthropic/claude-haiku-4.5` (OpenAI-compatible
API — no Anthropic SDK involved). Single secret: `OPENROUTER_API_KEY`.

### Request flow

```
Discord ──POST /interactions──► Worker
  1. verifyKey (ed25519)                          → 401 if signature invalid
  2. type 1 PING                                  → type 1 PONG
  3. type 2 APPLICATION_COMMAND
       • "Translate" (message context menu, type 3)
            - extract resolved target message text
            - respond NOW: type 5 DEFERRED, flags 64 (ephemeral)
            - ctx.waitUntil(translate(text, "auto") → edit reply)
       • "/translate" (slash, type 1)
            - read options: text (required), target (optional, default English)
            - respond NOW: type 5 DEFERRED, flags 64 (ephemeral)
            - ctx.waitUntil(translate(text, target) → edit reply)
  4. followup: PATCH /webhooks/{app_id}/{interaction_token}/messages/@original
```

The followup uses the interaction token + application id — no bot auth header needed.

## Components

- **`src/index.ts`** (~120 LOC) — verify → route → defer → followup. Handles PING,
  both command types, and error/edge-case followups.
- **`src/translate.ts`** — `translate(text, target)`:
  - `target === "auto"` → prompt: *"Translate the following message to Thai. If it
    is already Thai, translate it to English instead. Output only the translation,
    no preamble."*
  - explicit target (`"English"` / `"Thai"`) → prompt: *"Translate the following
    message to {target}. Output only the translation, no preamble."*
  - Calls OpenRouter, returns the translated string.
- **`scripts/register.ts`** — one-time registration of two global commands with
  `integration_types: [1]` (user-install) and `contexts: [0, 1, 2]`
  (guild / bot-DM / private channel). Prints the install URL. Uses `DISCORD_BOT_TOKEN`.
- **`wrangler.jsonc`** — Worker config.

### Secrets / config

| Name | Used by | Purpose |
|------|---------|---------|
| `DISCORD_PUBLIC_KEY` | Worker | ed25519 request verification |
| `DISCORD_APP_ID` | Worker, register | application id for followup webhook + registration |
| `DISCORD_BOT_TOKEN` | register script only | authorize command registration |
| `OPENROUTER_API_KEY` | Worker | OpenRouter chat completions |

## Command definitions

1. **Translate** — `type: 3` (MESSAGE context menu), no options. `integration_types: [1]`,
   `contexts: [0,1,2]`.
2. **translate** — `type: 1` (CHAT_INPUT slash), options:
   - `text` — STRING, required.
   - `target` — STRING, optional, choices `[{name:"English", value:"English"}, {name:"Thai", value:"Thai"}]`,
     default English (resolved in code when option absent).
   `integration_types: [1]`, `contexts: [0,1,2]`.

## Edge cases

- **No text** (context menu on embed/attachment/sticker-only message) →
  followup: `⚠️ No text to translate.`
- **Too long** → input capped (e.g. 4000 chars) before the API call to bound cost/latency.
- **OpenRouter error / timeout** → followup: `⚠️ Translation failed, try again.`
- **Already Thai** → handled inside the `auto` prompt (flips to English); no code branch.

## Testing

- **Unit (vitest):**
  - routing: PING → PONG; invalid signature → 401.
  - context-menu no-text branch → no-text followup.
  - `translate()` with mocked OpenRouter fetch: auto vs explicit target prompt selection.
- **E2E:** deploy → run register script → install to account → right-click a real
  message (Thai and English) → confirm ephemeral reply; run `/translate` with and
  without `target`. (Same validation loop as the RoleBot PoC.)
