// Any OpenAI-compatible chat-completions provider works by changing baseUrl +
// model + apiKey: OpenRouter (default), OpenAI, Groq, Together, DeepInfra,
// Fireworks, a local Ollama / LM Studio, etc.
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "anthropic/claude-haiku-4.5";

export interface LlmConfig {
  baseUrl: string; // OpenAI-compatible base, e.g. https://openrouter.ai/api/v1
  model: string;
  apiKey: string;
}

/** Resolve provider config from env, applying defaults (OpenRouter + Haiku). */
export function resolveLlmConfig(env: {
  LLM_BASE_URL?: string;
  LLM_MODEL?: string;
  LLM_API_KEY: string;
}): LlmConfig {
  return {
    baseUrl: (env.LLM_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    model: env.LLM_MODEL || DEFAULT_MODEL,
    apiKey: env.LLM_API_KEY,
  };
}

/** One chat-completions round trip. Returns the assistant text. Throws on error. */
async function chat(cfg: LlmConfig, system: string, user: string): Promise<string> {
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      "Content-Type": "application/json",
      "X-Title": "discord-translate-bot", // used by OpenRouter, ignored elsewhere
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0,
    }),
  });

  if (!res.ok) {
    throw new Error(`LLM ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const out = data.choices?.[0]?.message?.content?.trim();
  if (!out) {
    throw new Error("LLM returned no content");
  }
  return out;
}

/**
 * Translate `text`.
 * - `target === "auto"`: detect source; if Thai → English, otherwise → Thai.
 * - explicit target (e.g. "English", "Thai"): translate into that language.
 */
export async function translate(
  text: string,
  target: string,
  cfg: LlmConfig,
): Promise<string> {
  const system =
    target === "auto"
      ? "You are a translation engine. First detect the source language of the message (it may be English, Chinese, Japanese, or any language). If the source language is Thai, translate it into English; otherwise translate it into Thai. Reply with only the translation — no preamble, quotes, romanization, or notes."
      : `Translate the following message into ${target}. Reply with only the translation — no preamble, quotes, romanization, or notes.`;
  return chat(cfg, system, text);
}

/**
 * Translate the user's `reply` draft, using `context` (the message being replied
 * to) so the translation fits the conversation.
 * - `lang` empty → reply in the same language as the message being replied to.
 * - `lang` set → reply in that language.
 *
 * Uses a small JSON contract: forcing the model to name the `target` language
 * before producing `text` makes detection reliable and stops it from rambling
 * (free-form prompts mistranslated when the target resolved to English).
 */
export async function translateReply(
  reply: string,
  context: string,
  lang: string,
  cfg: LlmConfig,
): Promise<string> {
  const target = lang.trim()
    ? `"${lang.trim()}"`
    : "the language of the CONTEXT message (detect it)";
  const system =
    `You help a user reply in a chat. Translate the USER reply into ${target}.\n` +
    `CONTEXT (the message being replied to; do not translate it, use it only to detect language and tone):\n"""\n${context}\n"""\n` +
    `Respond with ONLY a JSON object: {"target":"<target language name>","text":"<the user reply written in the target language>"}. No other text.`;
  return extractReplyText(await chat(cfg, system, reply));
}

/** Pull `.text` out of the JSON reply, tolerating ```json code fences. */
function extractReplyText(raw: string): string {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    const obj = JSON.parse(cleaned) as { text?: unknown };
    if (typeof obj.text === "string") return obj.text.trim();
  } catch {
    // not JSON — fall back to the cleaned text
  }
  return cleaned;
}
