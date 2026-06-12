import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock signature verification so we can drive routing without real ed25519 keys.
vi.mock("discord-interactions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("discord-interactions")>();
  return { ...actual, verifyKey: vi.fn() };
});

import { verifyKey } from "discord-interactions";
import worker, { type Env } from "../src/index";
import {
  translateAuto,
  translateTo,
  translateReply,
  resolveLlmConfig,
  resolveLangConfig,
  type LlmConfig,
} from "../src/translate";

const langs = { primary: "Thai", secondary: "English" };

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

  it("attaches the original + reply button on a context-menu translation", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "สวัสดี" } }] }), {
        status: 200,
      }),
    );
    const { ctx, settle } = makeCtx();
    const res = await worker.fetch(
      post({
        type: 2,
        token: "tok",
        data: {
          type: 3,
          target_id: "m1",
          resolved: { messages: { m1: { content: "你好" } } },
        },
      }),
      env,
      ctx,
    );
    expect(await res.json()).toEqual({ type: 5, data: { flags: 64 } });
    await settle();
    const patch = fetchMock.mock.calls.at(-1)!; // last call = followup PATCH
    expect(String(patch[0])).toContain("/messages/@original");
    const sent = JSON.parse((patch[1] as RequestInit).body as string);
    expect(sent.content).toBe("> -# 你好\n**สวัสดี**");
    expect(sent.components[0].components[0].custom_id).toBe("open_reply");
  });

  it("opens the reply modal from the button, parsing the original", async () => {
    const { ctx } = makeCtx();
    const res = await worker.fetch(
      post({
        type: 3, // MESSAGE_COMPONENT
        data: { custom_id: "open_reply" },
        message: { content: "> -# 你好\n**สวัสดี**" },
      }),
      env,
      ctx,
    );
    const out = (await res.json()) as any;
    expect(out.type).toBe(9); // MODAL
    expect(out.data.custom_id).toBe("replymodal");
    const ctxInput = out.data.components.find(
      (c: any) => c.component?.custom_id === "ctx",
    );
    expect(ctxInput.component.value).toBe("你好"); // original carried into context field
    const td = out.data.components.find((c: any) => c.type === 10);
    expect(td.content).toContain("สวัสดี"); // shows the translation
    expect(td.content).not.toContain("你好"); // not the original (it's in the ctx field)
  });

  it("translates a reply from the modal submit using context + blank language", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "你好呀" } }] }), {
        status: 200,
      }),
    );
    const { ctx, settle } = makeCtx();
    const res = await worker.fetch(
      post({
        type: 5, // MODAL_SUBMIT
        token: "tok",
        data: {
          custom_id: "replymodal",
          components: [
            { type: 18, component: { type: 4, custom_id: "reply", value: "สวัสดีครับ" } },
            { type: 18, component: { type: 4, custom_id: "lang", value: "" } },
            { type: 18, component: { type: 4, custom_id: "ctx", value: "你好" } },
          ],
        },
      }),
      env,
      ctx,
    );
    expect(await res.json()).toEqual({ type: 5, data: { flags: 64 } });
    await settle();
    const llm = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(llm.messages[0].content).toContain("你好"); // context embedded
    expect(llm.messages[0].content).toContain("the language of the CONTEXT message");
    expect(llm.messages[1].content).toBe("สวัสดีครับ");
    const patch = JSON.parse(
      (fetchMock.mock.calls.at(-1)![1] as RequestInit).body as string,
    );
    expect(patch.content).toBe("你好呀"); // non-JSON mock falls back to raw text
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

  it("translateAuto builds a primary/secondary detect instruction", async () => {
    const m = mockOpenRouter();
    const out = await translateAuto("hello", langs, cfg);
    expect(out).toBe("out");
    const [url, init] = m.mock.calls[0];
    expect(String(url)).toBe("https://llm.example/v1/chat/completions");
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.model).toBe("test-model");
    expect(sent.messages[0].content).toContain("into Thai");
    expect(sent.messages[0].content).toContain("source language is Thai");
    expect(sent.messages[1].content).toBe("hello");
  });

  it("translateAuto honors a custom language pair", async () => {
    const m = mockOpenRouter();
    await translateAuto("hola", { primary: "Spanish", secondary: "English" }, cfg);
    const sent = JSON.parse((m.mock.calls[0][1] as RequestInit).body as string);
    expect(sent.messages[0].content).toContain("source language is Spanish");
    expect(sent.messages[0].content).toContain("into Spanish");
  });

  it("translateTo uses an explicit target instruction", async () => {
    const m = mockOpenRouter();
    await translateTo("สวัสดี", "English", cfg);
    const sent = JSON.parse((m.mock.calls[0][1] as RequestInit).body as string);
    expect(sent.messages[0].content).toContain("into English");
    expect(sent.messages[0].content).not.toContain("detect the source language");
  });

  it("throws on a non-OK response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("nope", { status: 500 }),
    );
    await expect(translateAuto("x", langs, cfg)).rejects.toThrow("LLM 500");
  });

  it("resolveLangConfig defaults to Thai/English and honors overrides", () => {
    expect(resolveLangConfig({})).toEqual({ primary: "Thai", secondary: "English" });
    expect(
      resolveLangConfig({ PRIMARY_LANG: "Spanish", SECONDARY_LANG: "French" }),
    ).toEqual({ primary: "Spanish", secondary: "French" });
  });

  it("translateReply embeds context and honors an explicit language", async () => {
    const m = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "x" } }] }), {
        status: 200,
      }),
    );
    await translateReply("ตอบกลับ", "你好", "Chinese", cfg);
    const sent = JSON.parse((m.mock.calls[0][1] as RequestInit).body as string);
    expect(sent.messages[0].content).toContain('"Chinese"');
    expect(sent.messages[0].content).toContain("你好");
    expect(sent.messages[1].content).toBe("ตอบกลับ");
  });

  it("translateReply extracts .text from fenced JSON output", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            { message: { content: '```json\n{"target":"Chinese","text":"你好呀"}\n```' } },
          ],
        }),
        { status: 200 },
      ),
    );
    expect(await translateReply("ตอบ", "你好", "", cfg)).toBe("你好呀");
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
