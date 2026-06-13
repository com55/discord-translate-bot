import {
  InteractionType,
  InteractionResponseType,
  InteractionResponseFlags,
  verifyKey,
} from "discord-interactions";
import {
  translateAuto,
  translateTo,
  translateReply,
  resolveLlmConfig,
  resolveLangConfig,
} from "./translate";

export interface Env {
  DISCORD_PUBLIC_KEY: string;
  DISCORD_APP_ID: string;
  LLM_API_KEY: string;
  // Holds the original message behind a reply button, keyed by a random id, so
  // the result message stays translation-only (no quoted original eating the
  // 2000-char budget).
  REPLY_CTX: KVNamespace;
  // Optional provider config (defaults: OpenRouter + claude-haiku-4.5).
  LLM_BASE_URL?: string;
  LLM_MODEL?: string;
  // Optional language pair (defaults: Thai / English).
  PRIMARY_LANG?: string;
  SECONDARY_LANG?: string;
}

// Application command types (Discord)
const CMD_CHAT_INPUT = 1;
const CMD_MESSAGE = 3;

// Component types (Discord)
const C_ACTION_ROW = 1;
const C_BUTTON = 2;
const C_TEXT_INPUT = 4;
const C_TEXT_DISPLAY = 10;
const C_LABEL = 18;

// Custom ids for the reply flow
const REPLY_BUTTON = "open_reply"; // followed by ":<kv-key>"
const REPLY_MODAL = "replymodal";

// Reply context lives in KV this long — comfortably past the 15-minute
// interaction-token window, but a reply you haven't sent within an hour is
// almost certainly abandoned.
const REPLY_CTX_TTL = 60 * 60; // 1 hour, in seconds

// Discord limits
const MAX_INPUT = 4000; // cap what we send to the model

const NO_TEXT = "⚠️ No text to translate.";
const FAILED = "⚠️ Translation failed, try again.";

interface MessageBody {
  content: string;
  components?: unknown[];
}

/** What we stash in KV behind a reply button. */
interface ReplyCtx {
  original: string;
  translation: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("discord-translate-bot", { status: 200 });
    }

    const signature = request.headers.get("X-Signature-Ed25519");
    const timestamp = request.headers.get("X-Signature-Timestamp");
    const body = await request.arrayBuffer();

    const valid =
      signature != null &&
      timestamp != null &&
      (await verifyKey(body, signature, timestamp, env.DISCORD_PUBLIC_KEY));
    if (!valid) {
      return new Response("invalid request signature", { status: 401 });
    }

    const interaction = JSON.parse(new TextDecoder().decode(body));

    if (interaction.type === InteractionType.PING) {
      return jsonResponse({ type: InteractionResponseType.PONG });
    }

    if (interaction.type === InteractionType.APPLICATION_COMMAND) {
      const data = interaction.data;

      // Message context menu "Translate" → auto (any source → Thai, Thai → English).
      // Result carries the original + a "translate a reply" button.
      if (data.type === CMD_MESSAGE) {
        const message = data.resolved?.messages?.[data.target_id];
        const text = (message?.content ?? "").slice(0, MAX_INPUT);
        return deferTranslate(ctx, interaction, env, text, "auto", true);
      }

      // Slash "/translate" → explicit target, default secondary language. No button.
      if (data.type === CMD_CHAT_INPUT) {
        const options: { name: string; value: string }[] = data.options ?? [];
        const opt = (name: string) => options.find((o) => o.name === name)?.value;
        const text = String(opt("text") ?? "").slice(0, MAX_INPUT);
        const target =
          String(opt("target") ?? "").trim() || resolveLangConfig(env).secondary;
        return deferTranslate(ctx, interaction, env, text, target, false);
      }
    }

    // Reply button on a translation result → open the reply modal. The original
    // message lives in KV under the key embedded in the button's custom_id.
    const customId: string = interaction.data?.custom_id ?? "";
    if (
      interaction.type === InteractionType.MESSAGE_COMPONENT &&
      customId.startsWith(`${REPLY_BUTTON}:`)
    ) {
      const key = customId.slice(REPLY_BUTTON.length + 1);
      const stored = await env.REPLY_CTX.get<ReplyCtx>(key, { type: "json" });
      // Key missing/expired → still let the user reply, just without context.
      return jsonResponse(
        buildReplyModal(stored?.original ?? "", stored?.translation ?? ""),
      );
    }

    // Reply modal submitted → translate the reply with context.
    if (
      interaction.type === InteractionType.MODAL_SUBMIT &&
      interaction.data?.custom_id === REPLY_MODAL
    ) {
      const v = extractModalValues(interaction.data.components);
      const reply = (v.reply ?? "").slice(0, MAX_INPUT);
      const context = (v.ctx ?? "").slice(0, MAX_INPUT);
      const lang = (v.lang ?? "").trim();
      return deferReply(ctx, interaction, env, reply, context, lang);
    }

    // Unhandled interaction type — acknowledge harmlessly.
    return jsonResponse({ type: InteractionResponseType.PONG });
  },
};

/** Defer ephemerally, then translate `text` and edit the reply in. */
function deferTranslate(
  ctx: ExecutionContext,
  interaction: { token: string },
  env: Env,
  text: string,
  target: string,
  withReplyButton: boolean,
): Response {
  const produce = async (): Promise<MessageBody> => {
    if (!text.trim()) return { content: NO_TEXT };
    let translated: string;
    try {
      const cfg = resolveLlmConfig(env);
      translated =
        target === "auto"
          ? await translateAuto(text, resolveLangConfig(env), cfg)
          : await translateTo(text, target, cfg);
    } catch (err) {
      console.error("translate failed", err);
      return { content: FAILED };
    }
    if (withReplyButton) {
      // Stash the original in KV and reference it from the button, so the result
      // message is just the translation — the original no longer eats into the
      // 2000-char budget (and isn't capped to fit one message anymore).
      const key = crypto.randomUUID();
      const original = text.replace(/\s+/g, " ").trim();
      await env.REPLY_CTX.put(
        key,
        JSON.stringify({ original, translation: translated } satisfies ReplyCtx),
        { expirationTtl: REPLY_CTX_TTL },
      );
      return { content: translated, components: [replyButtonRow(key)] };
    }
    return { content: translated };
  };

  ctx.waitUntil(
    produce().then((b) => editOriginalResponse(env.DISCORD_APP_ID, interaction.token, b)),
  );
  return deferredEphemeral();
}

/** Defer ephemerally, then translate the reply draft (with context) and edit it in. */
function deferReply(
  ctx: ExecutionContext,
  interaction: { token: string },
  env: Env,
  reply: string,
  context: string,
  lang: string,
): Response {
  const produce = async (): Promise<MessageBody> => {
    if (!reply.trim()) return { content: NO_TEXT };
    try {
      const out = await translateReply(reply, context, lang, resolveLlmConfig(env));
      return { content: out };
    } catch (err) {
      console.error("translateReply failed", err);
      return { content: FAILED };
    }
  };

  ctx.waitUntil(
    produce().then((b) => editOriginalResponse(env.DISCORD_APP_ID, interaction.token, b)),
  );
  return deferredEphemeral();
}

function replyButtonRow(key: string) {
  return {
    type: C_ACTION_ROW,
    components: [
      {
        type: C_BUTTON,
        style: 2,
        label: "✍️ Translate a reply",
        custom_id: `${REPLY_BUTTON}:${key}`,
      },
    ],
  };
}

/** Build the reply modal: read-only context + reply draft + target language. */
function buildReplyModal(original: string, translation: string) {
  return {
    type: InteractionResponseType.MODAL,
    data: {
      custom_id: REPLY_MODAL,
      title: "Translate a reply",
      components: [
        {
          type: C_TEXT_DISPLAY,
          content: `**${translation || "(your reply will be translated)"}**`,
        },
        {
          type: C_LABEL,
          label: "Your reply",
          component: {
            type: C_TEXT_INPUT,
            custom_id: "reply",
            style: 2,
            required: true,
            max_length: 2000,
            placeholder: "Type your reply; the bot will translate it.",
          },
        },
        {
          type: C_LABEL,
          label: "Target language",
          description: "Blank = the same language as the original message",
          component: {
            type: C_TEXT_INPUT,
            custom_id: "lang",
            style: 1,
            required: false,
            max_length: 30,
            placeholder: "e.g. English, Chinese, Spanish",
          },
        },
        {
          type: C_LABEL,
          label: "Original message (context)",
          description: "Used as context for the AI — edit or clear if needed",
          component: {
            type: C_TEXT_INPUT,
            custom_id: "ctx",
            style: 2,
            required: false,
            max_length: MAX_INPUT,
            value: original.slice(0, MAX_INPUT),
          },
        },
      ],
    },
  };
}

/** Read submitted text-input values from a MODAL_SUBMIT payload (Label or Action Row). */
function extractModalValues(
  components: {
    component?: { custom_id?: string; value?: string };
    components?: { custom_id?: string; value?: string }[];
  }[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of components ?? []) {
    if (c.component?.custom_id) {
      out[c.component.custom_id] = c.component.value ?? "";
    } else if (Array.isArray(c.components)) {
      for (const cc of c.components) {
        if (cc.custom_id) out[cc.custom_id] = cc.value ?? "";
      }
    }
  }
  return out;
}

/**
 * Edit the deferred placeholder with the result. The translation is sent inline;
 * if Discord rejects it for exceeding the per-message content limit, it is resent
 * as a `.txt` attachment instead (rather than guessing the limit up front, we let
 * Discord decide — this stays correct whatever the actual cap is). The interaction
 * token is the auth.
 */
async function editOriginalResponse(
  appId: string,
  token: string,
  body: MessageBody,
): Promise<void> {
  const url = `https://discord.com/api/v10/webhooks/${appId}/${token}/messages/@original`;

  const payload: Record<string, unknown> = { content: body.content };
  if (body.components) payload.components = body.components;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (res.ok) return;

  const errText = await res.text();
  if (isContentTooLong(res.status, errText)) {
    await editWithFile(url, body);
    return;
  }
  console.error("editOriginalResponse failed", res.status, errText);
}

/** Discord rejects over-length content with error code 50035 (Invalid Form Body). */
function isContentTooLong(status: number, errText: string): boolean {
  return status === 400 && errText.includes("50035");
}

/** Resend the result as a text-file attachment (multipart), keeping any components. */
async function editWithFile(url: string, body: MessageBody): Promise<void> {
  const payload: Record<string, unknown> = {
    attachments: [{ id: 0, filename: "translation.txt" }],
  };
  if (body.components) payload.components = body.components;

  const form = new FormData();
  form.append("payload_json", JSON.stringify(payload));
  form.append(
    "files[0]",
    new Blob([body.content], { type: "text/plain" }),
    "translation.txt",
  );

  // No explicit Content-Type — the runtime sets multipart/form-data + boundary.
  const res = await fetch(url, { method: "PATCH", body: form });
  if (!res.ok) {
    console.error("editWithFile failed", res.status, await res.text());
  }
}

function deferredEphemeral(): Response {
  return jsonResponse({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL },
  });
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" },
  });
}
