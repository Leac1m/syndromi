import type { ToolDescriptor } from "@syndromi/tools";
import { describe, expect, it, vi } from "vitest";
import { createProvider, FailoverProvider, modelOverride } from "./index.js";

const tools: ToolDescriptor[] = [
  { name: "balances", description: "wallet balances", inputSchema: { type: "object" } },
];
const reply = (body: unknown) =>
  vi.fn((_url: string | URL | Request, _init?: RequestInit) =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response),
  );
const sentInit = (fetch: ReturnType<typeof reply>, call = 0) => {
  const init = fetch.mock.calls[call]?.[1];
  if (!init) throw new Error(`no request #${call}`);
  return init;
};
const sentBody = (fetch: ReturnType<typeof reply>, call = 0) =>
  JSON.parse(String(sentInit(fetch, call).body));
const sentHeaders = (fetch: ReturnType<typeof reply>) =>
  sentInit(fetch).headers as Record<string, string>;

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
    expect(fetch.mock.calls[0]?.[0]).toBe("https://example.com/v1/chat/completions");
    expect(sentHeaders(fetch).authorization).toBe("Bearer k");
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

  it("fails fast on an exhausted daily quota instead of retrying", async () => {
    const fetch = vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 429,
        headers: new Headers(),
        text: () =>
          Promise.resolve('{"quotaId": "GenerateRequestsPerDayPerProjectPerModel-FreeTier"}'),
      } as Response),
    );
    const convo = createProvider(manifest, { GEMINI_API_KEY: "k" }, fetch).start("s", []);
    await expect(convo.send({ user: "go" })).rejects.toThrow(/daily request quota exhausted/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("names the missing key variable instead of calling out", () => {
    expect(() => createProvider(manifest, {})).toThrow(/GEMINI_API_KEY is not set/);
  });
});

describe("anthropic provider", () => {
  // The SDK reads a real Response (status, headers, body), so the mock returns one.
  const sdkReply = (...bodies: unknown[]) => {
    let call = 0;
    return vi.fn((_url: string | URL | Request, _init?: RequestInit) => {
      const body = bodies[Math.min(call++, bodies.length - 1)];
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: (body as { type?: string }).type === "error" ? 400 : 200,
          headers: { "content-type": "application/json", "request-id": "req_test" },
        }),
      );
    });
  };
  const message = (content: unknown[], stop_reason: string, extra: object = {}) => ({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason,
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 10, output_tokens: 5 },
    ...extra,
  });

  it("sends the Opus 5.5 request shape, parses tool_use and echoes thinking verbatim", async () => {
    const content = [
      { type: "thinking", thinking: "Check balances first.", signature: "sig_abc" },
      { type: "text", text: "Checking." },
      { type: "tool_use", id: "tu_1", name: "balances", input: {} },
    ];
    const fetch = sdkReply(message(content, "tool_use"), message([], "end_turn"));
    const provider = createProvider({ model: "byok:anthropic" }, { ANTHROPIC_API_KEY: "a" }, fetch);
    expect(provider.model).toBe("claude-opus-5-5");
    const convo = provider.start("system prompt", tools);
    const turn = await convo.send({ user: "go" });
    expect(turn).toEqual({
      text: "Checking.",
      toolCalls: [{ id: "tu_1", name: "balances", input: {} }],
      stop: "tool_calls",
    });
    const first = sentBody(fetch);
    expect(first).toMatchObject({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      system: "system prompt",
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      fallbacks: "default",
    });
    expect(first.tools[0]).toMatchObject({ name: "balances", input_schema: { type: "object" } });
    const headers = new Headers(sentInit(fetch).headers);
    expect(headers.get("x-api-key")).toBe("a");
    expect(headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");

    await convo.send({ toolResults: [{ id: "tu_1", name: "balances", content: "{}" }] });
    const second = sentBody(fetch, 1);
    expect(second.messages[1]).toEqual({ role: "assistant", content }); // signature intact
    expect(second.messages[2].content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "tu_1",
    });
  });

  it("turns a refusal into a stop with a clear message", async () => {
    const fetch = sdkReply(
      message([], "refusal", { stop_details: { type: "refusal", category: "cyber" } }),
    );
    const convo = createProvider(
      { model: "byok:anthropic" },
      { ANTHROPIC_API_KEY: "a" },
      fetch,
    ).start("s", tools);
    expect(await convo.send({ user: "go" })).toEqual({
      text: "Anthropic claude-opus-5-5 declined this request (cyber); the run stopped.",
      toolCalls: [],
      stop: "refusal",
    });
  });

  it("names the provider and model in API errors", async () => {
    const fetch = sdkReply({
      type: "error",
      error: { type: "invalid_request_error", message: "bad tools" },
    });
    const convo = createProvider(
      { model: "byok:anthropic", model_id: "claude-sonnet-5-5" },
      { ANTHROPIC_API_KEY: "a" },
      fetch,
    ).start("s", tools);
    await expect(convo.send({ user: "go" })).rejects.toThrow(
      /^Anthropic claude-sonnet-5-5 HTTP 400: .*bad tools/,
    );
  });
});

describe("timeouts", () => {
  const nvidia = {
    model: "openai-compatible:https://integrate.api.nvidia.com/v1",
    model_id: "meta/muse-glimmer-30b",
  };

  it("retries a timeout once, then names the provider and model", async () => {
    const fetch = vi.fn(() =>
      Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
    );
    const convo = createProvider(nvidia, {}, fetch).start("s", []);
    await expect(convo.send({ user: "go" })).rejects.toThrow(
      "NVIDIA meta/muse-glimmer-30b did not respond within 60 s (2 tries)",
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("says which host could not be reached", async () => {
    const fetch = vi.fn(() =>
      Promise.reject(
        Object.assign(new TypeError("fetch failed"), { cause: new Error("connect ECONNREFUSED") }),
      ),
    );
    const convo = createProvider(nvidia, {}, fetch).start("s", []);
    await expect(convo.send({ user: "go" })).rejects.toThrow(
      "NVIDIA meta/muse-glimmer-30b: cannot reach integrate.api.nvidia.com (2 tries): connect ECONNREFUSED",
    );
  });
});

describe("fallback model", () => {
  const nvidia = {
    model: "openai-compatible:https://integrate.api.nvidia.com/v1",
    model_id: "meta/muse-glimmer-30b",
    api_key_env: "NVIDIA_API_KEY",
  };
  const env = { NVIDIA_API_KEY: "n", ANTHROPIC_API_KEY: "a" };

  it("wraps the primary when SYNDROMI_FALLBACK_MODEL or fallback_model is set", () => {
    const viaEnv = createProvider(nvidia, {
      ...env,
      SYNDROMI_FALLBACK_MODEL: "anthropic:claude-opus-5-5",
    });
    expect(viaEnv).toBeInstanceOf(FailoverProvider);
    expect((viaEnv as FailoverProvider).backup.model).toBe("claude-opus-5-5");
    const viaManifest = createProvider(
      { ...nvidia, fallback_model: "gemini:gemini-3.8-flash" },
      { ...env, GEMINI_API_KEY: "g", SYNDROMI_FALLBACK_MODEL: "anthropic:claude-opus-5-5" },
    );
    expect((viaManifest as FailoverProvider).backup.model).toBe("gemini-3.8-flash");
    expect(createProvider(nvidia, env)).not.toBeInstanceOf(FailoverProvider);
  });

  it("explains a bad or unusable fallback", () => {
    expect(() =>
      createProvider(nvidia, { ...env, SYNDROMI_FALLBACK_MODEL: "claude-opus-5-5" }),
    ).toThrow(/must name a preset/);
    expect(() =>
      createProvider(nvidia, { NVIDIA_API_KEY: "n", SYNDROMI_FALLBACK_MODEL: "anthropic:x" }),
    ).toThrow(/fallback model anthropic:x: ANTHROPIC_API_KEY is not set/);
  });
});

describe("modelOverride", () => {
  it("maps presets to verified endpoints and keeps bare ids on the manifest's provider", () => {
    expect(modelOverride("nvidia:meta/muse-glimmer-30b")).toEqual({
      model: "openai-compatible:https://integrate.api.nvidia.com/v1",
      api_key_env: "NVIDIA_API_KEY",
      model_id: "meta/muse-glimmer-30b",
    });
    expect(modelOverride("anthropic:claude-opus-5-5")).toMatchObject({ model: "byok:anthropic" });
    expect(modelOverride("gemini-3.7-flash")).toEqual({ model_id: "gemini-3.7-flash" });
    expect(() => modelOverride("gemini:")).toThrow(/missing model id/);
  });
});

// Opt-in live checks, one per test provider: a tool call, then an answer using its result.
const liveProviders = [
  { name: "NVIDIA", key: "NVIDIA_API_KEY", spec: "nvidia:meta/muse-glimmer-30b" },
  { name: "Gemini", key: "GEMINI_API_KEY", spec: "gemini:gemini-3.8-flash" },
  { name: "Anthropic", key: "ANTHROPIC_API_KEY", spec: "anthropic:claude-opus-5-5" },
];
for (const p of liveProviders) {
  const live = process.env[p.key] ? it : it.skip;
  describe(`live ${p.name} (skipped without ${p.key})`, () => {
    live(
      "calls a tool, takes the result, and answers",
      async () => {
        const provider = createProvider({
          ...(modelOverride(p.spec) as { model: string; model_id: string; api_key_env: string }),
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
}
