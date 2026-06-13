# discord-translate-bot — agent context

Personal, single-user Discord translation bot. One Cloudflare Worker, user-installed
(works everywhere incl. DMs and servers the bot isn't in), all responses ephemeral.
See `README.md` for end-user setup; this file is for working in the code.

## Commands
- `npm test` — vitest (mocks `fetch` + a fake KV; runs fully offline)
- `npm run typecheck` — `tsc --noEmit`
- `npm run dev` — local `wrangler dev` (needs `.dev.vars`; KV is simulated locally)
- `npm run deploy` — `wrangler deploy`
- `npm run register` — (re)register the slash + context-menu commands; run after any
  change to a command's shape

## Architecture
Stateless request handling. `discord-interactions` ed25519 verify → route → respond
with a deferred-ephemeral ack (beats Discord's 3s deadline) → `ctx.waitUntil` translate
→ PATCH `/webhooks/{app_id}/{token}/messages/@original`. The interaction token is the
auth — there is no bot token at runtime (it's only used by `register.ts`).

Three interaction kinds:
- **Context-menu "Translate"** (`translateAuto`): detect source; if it is PRIMARY_LANG
  translate into SECONDARY_LANG, else into PRIMARY_LANG. Result is **translation-only**
  plus a "✍️ Translate a reply" button.
- **Reply button → modal** (`translateReply`): translate a reply using the original
  message as context. Uses a JSON `{target,text}` contract because free-form prompts
  rambled / mistranslated when the target resolved to English.
- **`/translate text:<draft> [target:<lang>]`** (`translateTo`): explicit target,
  default SECONDARY_LANG.

### Reply context lives in KV — do not quote the original inline
The original message is stored in **Workers KV** (`REPLY_CTX` binding, 1-hour TTL) under
a random key embedded in the button's `custom_id` (`open_reply:<uuid>`). The result
message is the translation only. On reply-button click, the original is loaded from KV;
if the key has expired the modal still opens, just with an empty context field.

KV is read **once**, at button-click. The original is then prefilled into the modal's
`ctx` field, and at MODAL_SUBMIT the context is read back from that submitted field —
**not** re-fetched from KV (the modal's `custom_id` doesn't carry the key). So clearing
the `ctx` field in the modal genuinely drops the context. (custom_id is capped at 100
chars, which is also why the original can't just live in the button id — hence KV.)

Rationale (don't regress this): the original used to be quoted inline as `> -# ...`,
which ate into Discord's 2000-char budget and forced splitting long translations across
multiple ephemeral follow-ups — fragile (broke markdown across cuts, hard-cut Thai/Chinese
mid-word, depended on follow-up ordering). KV removed all of that.

### Over-length translations → .txt attachment
Discord caps webhook/interaction message content at **2000 chars**. This is a hard cap;
a user's Nitro does **not** raise it for bot/webhook messages. `editOriginalResponse`
sends the translation inline first, and only if Discord rejects it with error code 50035
does it resend the text as a `translation.txt` attachment (multipart). We let Discord
decide rather than hardcoding the limit.

## Key files
- `src/index.ts` — verify, route, defer; KV store/read; reply modal; file fallback
- `src/translate.ts` — the three LLM calls + provider/language config resolution
- `scripts/register.ts` — one-time command registration (user-installable)
- `test/index.test.ts` — routing + translate unit tests

## Config
Non-secret `vars` in `wrangler.jsonc`: `LLM_BASE_URL`, `LLM_MODEL`, `PRIMARY_LANG`,
`SECONDARY_LANG` (defaults: OpenRouter + `anthropic/claude-haiku-4.5`, Thai/English). Any
OpenAI-compatible `/chat/completions` endpoint works by swapping base URL + model.
`LLM_API_KEY` is a secret (`wrangler secret put`). The `REPLY_CTX` KV namespace id is in
`wrangler.jsonc` and is not a secret (access still requires account auth).

### Prompt lessons (don't regress)
These prompts are the way they are because simpler versions failed. Re-test against
these cases if you touch them:
- **`translateAuto` — detect source first.** An earlier prompt ("translate into PRIMARY;
  if already PRIMARY, into SECONDARY") leaked **short** inputs to SECONDARY because the
  secondary language was named in the main clause and primed the model (e.g. Chinese
  `好的`/`在吗` came back in English). The fix is the current framing: detect the source
  first, *then* branch. Don't fold the branch back into the lead sentence.
- **`translateReply` — pin language + script when auto-detecting.** With a blank target,
  a Russian (Cyrillic) message intermittently got answered in Chinese. The `detectRule`
  forces the output to match the context's exact language *and writing system*; keep it.
- The reply uses a JSON `{target,text}` contract (not free-form) so the model commits to
  a target language before translating — this is what stopped the rambling/mis-targeting.
- `temperature: 0` everywhere — translation should be deterministic.

## Conventions / gotchas
- Style: tight code; comments explain *why*, not *what*; no speculative abstraction.
- Tests mock `globalThis.fetch` and use an in-memory KV stub — keep them network-free.
- `compatibility_date` must not be in the future — Cloudflare rejects it.
- Keep every response ephemeral; keep the user-install (`integration_type=1`) flow.
- The reply modal is **Components V2**: Text Inputs (type 4) must be wrapped in a Label
  (type 18), and static text uses Text Display (type 10). Modals need no components-v2
  flag (messages would). `extractModalValues` reads `components[i].component.value`.
- `register.ts` is the only thing that uses the bot token; it does a bulk PUT that
  **replaces all** global commands and prints the `integration_type=1` install URL.
- `isContentTooLong` keys off Discord error `50035`, which is the generic "Invalid Form
  Body" code — a malformed payload (not just over-length) would also route to the file
  fallback. Fine today (the file retry just fails and logs), but tighten if it bites.
