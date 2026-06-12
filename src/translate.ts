const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = "anthropic/claude-haiku-4.5";

/**
 * Translate `text` using OpenRouter (Claude Haiku).
 *
 * - `target === "auto"`: translate to Thai; if the text is already Thai, to English.
 * - explicit target (e.g. "English", "Thai"): translate to that language.
 *
 * Returns the translated string. Throws on a non-OK response or empty output.
 */
export async function translate(
  text: string,
  target: string,
  apiKey: string,
): Promise<string> {
  const instruction =
    target === "auto"
      ? "Translate the following message to Thai. If it is already written in Thai, translate it to English instead. Output only the translation, with no preamble, quotes, or explanation."
      : `Translate the following message to ${target}. Output only the translation, with no preamble, quotes, or explanation.`;

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-Title": "discord-translate-bot",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: instruction },
        { role: "user", content: text },
      ],
      temperature: 0.2,
    }),
  });

  if (!res.ok) {
    throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const out = data.choices?.[0]?.message?.content?.trim();
  if (!out) {
    throw new Error("OpenRouter returned no content");
  }
  return out;
}
