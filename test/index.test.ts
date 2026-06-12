import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock signature verification so we can drive routing without real ed25519 keys.
vi.mock("discord-interactions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("discord-interactions")>();
  return { ...actual, verifyKey: vi.fn() };
});

import { verifyKey } from "discord-interactions";
import worker, { type Env } from "../src/index";
import { translate } from "../src/translate";

const env: Env = {
  DISCORD_PUBLIC_KEY: "pub",
  DISCORD_APP_ID: "app123",
  OPENROUTER_API_KEY: "key",
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
    const out = await translate("hello", "auto", "key");
    expect(out).toBe("out");
    const sent = JSON.parse((m.mock.calls[0][1] as RequestInit).body as string);
    expect(sent.messages[0].content).toContain("to Thai");
    expect(sent.messages[0].content).toContain("already written in Thai");
    expect(sent.messages[1].content).toBe("hello");
  });

  it("uses an explicit target instruction otherwise", async () => {
    const m = mockOpenRouter();
    await translate("สวัสดี", "English", "key");
    const sent = JSON.parse((m.mock.calls[0][1] as RequestInit).body as string);
    expect(sent.messages[0].content).toContain("to English");
    expect(sent.messages[0].content).not.toContain("already written in Thai");
  });

  it("throws on a non-OK response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("nope", { status: 500 }),
    );
    await expect(translate("x", "auto", "key")).rejects.toThrow("OpenRouter 500");
  });
});
