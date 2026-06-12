import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock signature verification so we can drive routing without real ed25519 keys.
vi.mock("discord-interactions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("discord-interactions")>();
  return { ...actual, verifyKey: vi.fn() };
});

import { verifyKey } from "discord-interactions";
import worker, { type Env } from "../src/index";
import { translate, resolveLlmConfig, type LlmConfig } from "../src/translate";

const env: Env = {
  DISCORD_PUBLIC_KEY: "pub",
  DISCORD_APP_ID: "app123",
  LLM_API_KEY: "key",
};

const cfg: LlmConfig = {
  baseUrl: "https://llm.example/v1",
  model: "test-model",
  apiKey: "key",
};

function makeCtx() {
  const promises: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => promises.push(p),
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
  return { ctx, settle: () => Promise.all(promises) };
}

function post(body: unknown): Request {
  return new Request("https://bot.example/", {
    method: "POST",
    headers: {
      "X-Signature-Ed25519": "sig",
      "X-Signature-Timestamp": "ts",
    },
    body: JSON.stringify(body),
  });
}

describe("interaction routing", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(verifyKey).mockResolvedValue(true);
  });

  it("responds PONG to a PING", async () => {
    const { ctx } = makeCtx();
    const res = await worker.fetch(post({ type: 1 }), env, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ type: 1 });
  });

  it("rejects an invalid signature with 401", async () => {
    vi.mocked(verifyKey).mockResolvedValue(false);
    const { ctx } = makeCtx();
    const res = await worker.fetch(post({ type: 1 }), env, ctx);
    expect(res.status).toBe(401);
  });

  it("defers ephemerally for a context-menu command", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 }),
    );
    const { ctx, settle } = makeCtx();
    const res = await worker.fetch(
      post({
        type: 2,
        token: "tok",
        data: {
          type: 3,
          target_id: "m1",
          resolved: { messages: { m1: { content: "" } } },
        },
      }),
      env,
      ctx,
    );
    expect(await res.json()).toEqual({ type: 5, data: { flags: 64 } });
    await settle();
    // No text → follow-up PATCH carries the no-text notice, no OpenRouter call.
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/webhooks/app123/tok/messages/@original");
    expect(JSON.parse((init as RequestInit).body as string).content).toContain(
      "No text to translate",
    );
  });
});

describe("translate()", () => {
  beforeEach(() => vi.restoreAllMocks());

  function mockOpenRouter() {
    return vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { content: "  out  " } }] }),
        { status: 200 },
      ),
    );
  }

  it("uses the auto (→Thai/English) instruction for target 'auto'", async () => {
    const m = mockOpenRouter();
    const out = await translate("hello", "auto", cfg);
    expect(out).toBe("out");
    const [url, init] = m.mock.calls[0];
    expect(String(url)).toBe("https://llm.example/v1/chat/completions");
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.model).toBe("test-model");
    expect(sent.messages[0].content).toContain("into Thai");
    expect(sent.messages[0].content).toContain("source language is Thai");
    expect(sent.messages[1].content).toBe("hello");
  });

  it("uses an explicit target instruction otherwise", async () => {
    const m = mockOpenRouter();
    await translate("สวัสดี", "English", cfg);
    const sent = JSON.parse((m.mock.calls[0][1] as RequestInit).body as string);
    expect(sent.messages[0].content).toContain("into English");
    expect(sent.messages[0].content).not.toContain("detect the source language");
  });

  it("throws on a non-OK response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("nope", { status: 500 }),
    );
    await expect(translate("x", "auto", cfg)).rejects.toThrow("LLM 500");
  });
});

describe("resolveLlmConfig()", () => {
  it("defaults to OpenRouter + claude-haiku-4.5", () => {
    expect(resolveLlmConfig({ LLM_API_KEY: "k" })).toEqual({
      baseUrl: "https://openrouter.ai/api/v1",
      model: "anthropic/claude-haiku-4.5",
      apiKey: "k",
    });
  });

  it("honors overrides and strips a trailing slash from the base URL", () => {
    expect(
      resolveLlmConfig({
        LLM_API_KEY: "k",
        LLM_BASE_URL: "https://api.groq.com/openai/v1/",
        LLM_MODEL: "llama-3.3-70b",
      }),
    ).toEqual({
      baseUrl: "https://api.groq.com/openai/v1",
      model: "llama-3.3-70b",
      apiKey: "k",
    });
  });
});
