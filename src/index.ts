import {
  InteractionType,
  InteractionResponseType,
  InteractionResponseFlags,
  verifyKey,
} from "discord-interactions";
import { translate } from "./translate";

export interface Env {
  DISCORD_PUBLIC_KEY: string;
  DISCORD_APP_ID: string;
  OPENROUTER_API_KEY: string;
}

// Application command types (Discord)
const CMD_CHAT_INPUT = 1;
const CMD_MESSAGE = 3;

// Discord limits
const MAX_INPUT = 4000; // cap what we send to the model
const MAX_DISCORD_CONTENT = 2000; // Discord message content limit

const NO_TEXT = "⚠️ No text to translate.";
const FAILED = "⚠️ Translation failed, try again.";

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

      // Message context menu "Translate" → auto (any source → Thai, Thai → English)
      if (data.type === CMD_MESSAGE) {
        const message = data.resolved?.messages?.[data.target_id];
        const text = (message?.content ?? "").slice(0, MAX_INPUT);
        return deferAndFollowUp(ctx, interaction, env, text, "auto");
      }

      // Slash "/translate" → explicit target, default English
      if (data.type === CMD_CHAT_INPUT) {
        const options: { name: string; value: string }[] = data.options ?? [];
        const opt = (name: string) => options.find((o) => o.name === name)?.value;
        const text = String(opt("text") ?? "").slice(0, MAX_INPUT);
        const target = String(opt("target") ?? "English");
        return deferAndFollowUp(ctx, interaction, env, text, target);
      }
    }

    // Unhandled interaction type — acknowledge harmlessly.
    return jsonResponse({ type: InteractionResponseType.PONG });
  },
};

/**
 * Respond immediately with a deferred ephemeral ack, then translate and edit the
 * original response in the background (within Discord's 15-minute token window).
 */
function deferAndFollowUp(
  ctx: ExecutionContext,
  interaction: { token: string },
  env: Env,
  text: string,
  target: string,
): Response {
  const produce = async (): Promise<string> => {
    if (!text.trim()) return NO_TEXT;
    try {
      return await translate(text, target, env.OPENROUTER_API_KEY);
    } catch (err) {
      console.error("translate failed", err);
      return FAILED;
    }
  };

  ctx.waitUntil(
    produce().then((content) =>
      editOriginalResponse(env.DISCORD_APP_ID, interaction.token, content),
    ),
  );

  return jsonResponse({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL },
  });
}

/** Edit the deferred interaction response. The interaction token is the auth. */
async function editOriginalResponse(
  appId: string,
  token: string,
  content: string,
): Promise<void> {
  const res = await fetch(
    `https://discord.com/api/v10/webhooks/${appId}/${token}/messages/@original`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: content.slice(0, MAX_DISCORD_CONTENT) }),
    },
  );
  if (!res.ok) {
    console.error("editOriginalResponse failed", res.status, await res.text());
  }
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" },
  });
}
