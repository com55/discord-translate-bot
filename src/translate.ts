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

/**
 * Translate `text` via an OpenAI-compatible chat-completions endpoint.
 *
 * - `target === "auto"`: translate to Thai; if the text is already Thai, to English.
 * - explicit target (e.g. "English", "Thai"): translate to that language.
 *
 * Returns the translated string. Throws on a non-OK response or empty output.
 */
export async function translate(
  text: string,
  target: string,
  cfg: LlmConfig,
): Promise<string> {
  const instruction =
    target === "auto"
      ? "Translate the following message to Thai. If it is already written in Thai, translate it to English instead. Output only the translation, with no preamble, quotes, or explanation."
      : `Translate the following message to ${target}. Output only the translation, with no preamble, quotes, or explanation.`;

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
        { role: "system", content: instruction },
        { role: "user", content: text },
      ],
      temperature: 0.2,
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
