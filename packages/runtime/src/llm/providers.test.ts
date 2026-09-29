import type { ToolDescriptor } from "@syndromi/tools";
import { describe, expect, it, vi } from "vitest";
import { createProvider } from "./index.js";

const tools: ToolDescriptor[] = [
  { name: "balances", description: "wallet balances", inputSchema: { type: "object" } },
];
const reply = (body: unknown) =>
  vi.fn((_url: string | URL | Request, _init?: RequestInit) =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response),
  );
const sentBody = (fetch: ReturnType<typeof reply>, call = 0) =>
  JSON.parse(String((fetch.mock.calls[call]?.[1] as RequestInit).body));

describe("openai-compatible provider", () => {
  const manifest = {
    model: "openai-compatible:https://example.com/v1/",
    model_id: "gemini-3.8-flash",
    api_key_env: "GEMINI_API_KEY",
  };
  const assistant = {
    role: "assistant",
    tool_calls: [
      {
        id: "call_1",
        type: "function",
        extra_content: { google: { thought_signature: "sig" } },
        function: { name: "balances", arguments: "{}" },
      },
      { id: "call_2", type: "function", function: { name: "pyth-price", arguments: "{bad" } },
    ],
  };

  it("parses tool calls and echoes the assistant message verbatim", async () => {
    const fetch = reply({ choices: [{ finish_reason: "tool_calls", message: assistant }] });
    const provider = createProvider(manifest, { GEMINI_API_KEY: "k" }, fetch);
    const convo = provider.start("be careful", tools);
    const turn = await convo.send({ user: "go" });
    expect(turn.stop).toBe("tool_calls");
    expect(turn.toolCalls).toEqual([
      { id: "call_1", name: "balances", input: {} },
      { id: "call_2", name: "pyth-price", input: "{bad" },
    ]);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("https://example.com/v1/chat/completions");
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer k");
    expect(sentBody(fetch).tools[0].function.name).toBe("balances");

    await convo.send({ toolResults: [{ id: "call_1", name: "balances", content: "{}" }] });
    const second = sentBody(fetch, 1);
    expect(second.messages[2]).toEqual(assistant); // thought signature preserved
    expect(second.messages[3]).toMatchObject({ role: "tool", tool_call_id: "call_1" });
  });

  it("retries a 503 and then succeeds", async () => {
    let calls = 0;
    const fetch = vi.fn(() => {
      calls++;
      if (calls === 1) {
        return Promise.resolve({
          ok: false,
          status: 503,
          headers: new Headers({ "retry-after": "0.01" }),
          text: () => Promise.resolve("high demand"),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ finish_reason: "stop", message: { role: "assistant", content: "hi" } }],
          }),
      } as Response);
    });
    const convo = createProvider(manifest, { GEMINI_API_KEY: "k" }, fetch).start("s", []);
    expect(await convo.send({ user: "go" })).toEqual({ text: "hi", toolCalls: [], stop: "end" });
    expect(calls).toBe(2);
  });

  it("names the missing key variable instead of calling out", () => {
    expect(() => createProvider(manifest, {})).toThrow(/GEMINI_API_KEY is not set/);
  });
});

describe("anthropic provider", () => {
  it("parses tool_use blocks and sends tool_result blocks", async () => {
    const content = [
      { type: "text", text: "Checking." },
      { type: "tool_use", id: "tu_1", name: "balances", input: {} },
    ];
    const fetch = reply({ content, stop_reason: "tool_use" });
    const provider = createProvider({ model: "byok:anthropic" }, { ANTHROPIC_API_KEY: "a" }, fetch);
    expect(provider.model).toBe("claude-sonnet-5");
    const convo = provider.start("system prompt", tools);
    const turn = await convo.send({ user: "go" });
    expect(turn).toEqual({
      text: "Checking.",
      toolCalls: [{ id: "tu_1", name: "balances", input: {} }],
      stop: "tool_calls",
    });
    const first = sentBody(fetch);
    expect(first.system).toBe("system prompt");
    expect(first.tools[0]).toMatchObject({ name: "balances", input_schema: { type: "object" } });
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("a");

    await convo.send({ toolResults: [{ id: "tu_1", name: "balances", content: "{}" }] });
    const second = sentBody(fetch, 1);
    expect(second.messages[1]).toEqual({ role: "assistant", content });
    expect(second.messages[2].content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "tu_1",
    });
  });
});

const live = process.env.GEMINI_API_KEY ? it : it.skip;
describe("live Gemini (skipped without GEMINI_API_KEY)", () => {
  live(
    "calls a tool, takes the result, and answers",
    async () => {
      const provider = createProvider({
        model: "openai-compatible:https://generativelanguage.googleapis.com/v1beta/openai",
        model_id: "gemini-3.8-flash",
        api_key_env: "GEMINI_API_KEY",
      });
      const convo = provider.start("Always call the balances tool before answering.", tools);
      const first = await convo.send({ user: "How much SOL do I have?" });
      const call = first.toolCalls[0];
      expect(call?.name).toBe("balances");
      if (!call) return;
      const second = await convo.send({
        toolResults: [{ id: call.id, name: call.name, content: '{"SOL": 1.5}' }],
      });
      expect(second.text).toMatch(/1\.5/);
    },
    180_000,
  );
});
