import { describe, expect, it } from "vitest";
import { BENCH_MS, FailoverProvider } from "./failover.js";
import type { Conversation, LlmNotice, LlmProvider, Turn } from "./types.js";

const done: Turn = { text: "done", toolCalls: [], stop: "end" };
const toolTurn: Turn = {
  toolCalls: [{ id: "1", name: "balances", input: {} }],
  stop: "tool_calls",
};

/** A provider whose n-th send (across all its conversations) follows `script`. */
function fake(name: string, script: (call: number) => Turn | Error) {
  const provider = {
    name,
    model: `${name}-model`,
    calls: 0,
    starts: 0,
    start(): Conversation {
      provider.starts++;
      return {
        send: async () => {
          const out = script(provider.calls++);
          if (out instanceof Error) throw out;
          return out;
        },
      };
    },
  };
  return provider satisfies LlmProvider;
}

describe("FailoverProvider", () => {
  it("restarts a run on the backup when the first request fails, and says so", async () => {
    const primary = fake("nvidia", () => new Error("NVIDIA m did not respond within 60 s"));
    const backup = fake("anthropic", () => done);
    const notices: LlmNotice[] = [];
    const provider = new FailoverProvider(primary, backup);
    const turn = await provider.start("s", [], (n) => void notices.push(n)).send({ user: "go" });
    expect(turn).toEqual(done);
    expect(notices).toEqual([
      {
        type: "llm_failover",
        from: "nvidia:nvidia-model",
        to: "anthropic:anthropic-model",
        reason: "NVIDIA m did not respond within 60 s",
      },
    ]);
    expect(provider.model).toBe("anthropic-model"); // the primary is benched
  });

  it("does not switch mid-run, but benches the primary for the next runs", async () => {
    let now = 0;
    const primary = fake("nvidia", (call) => (call === 0 ? toolTurn : new Error("HTTP 503")));
    const backup = fake("anthropic", () => done);
    const provider = new FailoverProvider(primary, backup, () => now);
    const convo = provider.start("s", []);
    expect(await convo.send({ user: "go" })).toEqual(toolTurn);
    await expect(
      convo.send({ toolResults: [{ id: "1", name: "balances", content: "{}" }] }),
    ).rejects.toThrow("HTTP 503");
    expect(backup.starts).toBe(0); // tools already ran on the primary's plan: no replay

    expect(await provider.start("s", []).send({ user: "go" })).toEqual(done);
    expect(backup.starts).toBe(1);
    now += BENCH_MS;
    expect(provider.model).toBe("nvidia-model"); // back to the primary after the bench
  });

  it("reports both failures when the backup fails too", async () => {
    const primary = fake("nvidia", () => new Error("primary down"));
    const backup = fake("anthropic", () => new Error("backup down"));
    const convo = new FailoverProvider(primary, backup).start("s", []);
    await expect(convo.send({ user: "go" })).rejects.toThrow("primary down; backup: backup down");
  });

  it("treats a refusal as an answer, not an outage", async () => {
    const refusal: Turn = { text: "declined", toolCalls: [], stop: "refusal" };
    const primary = fake("anthropic", () => refusal);
    const backup = fake("nvidia", () => done);
    const provider = new FailoverProvider(primary, backup);
    expect(await provider.start("s", []).send({ user: "go" })).toEqual(refusal);
    expect(provider.model).toBe("anthropic-model");
  });
});
