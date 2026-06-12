# Implementation Plan — Personal Discord Translate Bot

Spec: `docs/superpowers/specs/2026-06-13-discord-translate-bot-design.md`

Tracer-bullet phases. Each phase is independently verifiable; don't start the next
until the current one's verify step passes.

## Phase 0 — Scaffold
- `package.json`, `tsconfig.json`, `wrangler.jsonc`, `.gitignore`, `.dev.vars.example`
- `src/index.ts` skeleton (fetch handler returns 200), `vitest` config
- **Verify:** `npx wrangler dev` boots; `npm test` runs (placeholder passing).

## Phase 1 — Verify + PING/PONG  (end-to-end tracer)
- ed25519 request verification (`discord-interactions` verifyKey or WebCrypto).
- Respond `type 1` PONG to `type 1` PING; reject bad signature with 401.
- **Verify:** unit tests (PING→PONG, bad-sig→401) pass. Deploy, set the app's
  `interactions_endpoint_url` → Discord PING validation returns 200.

## Phase 2 — Command registration script
- `scripts/register.ts`: register both global commands with
  `integration_types: [1]`, `contexts: [0,1,2]`. Print install URL.
  - "Translate" — message context menu (`type: 3`).
  - "translate" — slash (`type: 1`) with `text` (required) + `target` (optional,
    choices English/Thai).
- **Verify:** run script → both commands registered (200); install URL printed.

## Phase 3 — Context menu Translate: defer + followup (echo first)
- Route `type 2` message command → extract resolved message text → respond
  `type 5` DEFERRED ephemeral (flags 64) → `ctx.waitUntil` PATCH @original with the
  **raw text** (no translation yet) to prove the defer+webhook loop.
- **Verify:** right-click a message → ephemeral reply echoes the message text.

## Phase 4 — Wire translate() via OpenRouter (auto → Thai)
- `src/translate.ts`: `translate(text, "auto")` → OpenRouter
  `anthropic/claude-haiku-4.5`. Prompt: to Thai; if already Thai, to English.
- Plug into context menu followup.
- **Verify:** right-click English / Japanese / Chinese message → Thai reply; Thai
  message → English reply.

## Phase 5 — /translate slash command
- Route `type 2` CHAT_INPUT → read `text`, `target` (default English when absent) →
  defer ephemeral → `translate(text, target)` → followup.
- **Verify:** `/translate text:...` → English; `target:Thai` → Thai.

## Phase 6 — Edge cases + tests
- No-text message → `⚠️ No text to translate.`
- Input length cap (4000 chars).
- OpenRouter error/timeout → `⚠️ Translation failed, try again.`
- Finalize vitest units (routing, no-text branch, translate prompt selection w/ mocked fetch).
- **Verify:** embed-only message → no-text followup; forced API error → failure
  followup; `npm test` green.

## Phase 7 — README + deploy
- `README.md`: secrets, deploy, register, install steps.
- **Verify:** following the README from scratch reproduces a working deploy.
