import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "./api";
import { feedLine, periodWord, runStatus, whereItRuns } from "./format";

const event = (type: string, fields: Record<string, unknown> = {}): ActivityEvent => ({
  seq: 1,
  agentName: "dca-agent",
  type,
  at: "2026-10-03T10:00:00.000Z",
  ...fields,
});

describe("feedLine", () => {
  it("shows BLOCKED in the bad tone with its reasons, and hides the duplicate decision", () => {
    expect(
      feedLine(
        event("blocked", {
          summary: "transfer 5 USDC to AhLo…",
          reasons: ["token destination AhLo… not in allowlist"],
        }),
      ),
    ).toMatchObject({
      tone: "bad",
      text: "BLOCKED: transfer 5 USDC to AhLo… — token destination AhLo… not in allowlist",
    });
    expect(feedLine(event("decision", { verdict: "block", summary: "x" }))).toBeUndefined();
  });

  it("describes decisions, sends and approvals, keeping signatures for explorer links", () => {
    expect(
      feedLine(event("decision", { verdict: "allow", summary: "swap 3 USDC → SOL", usd: 3 })),
    ).toMatchObject({
      tone: "good",
      text: "allowed: swap 3 USDC → SOL ($3.00)",
    });
    expect(feedLine(event("tx_sent", { summary: "swap", signature: "sig1" }))).toMatchObject({
      signature: "sig1",
    });
    expect(
      feedLine(event("approval", { kind: "draft", status: "executed", summary: "swap 15 USDC" })),
    ).toMatchObject({
      tone: "good",
      text: "approval request executed: swap 15 USDC",
    });
    expect(
      feedLine(event("approval", { kind: "kill", status: "revoked", summary: "all" }))?.text,
    ).toMatch(/^kill switch revoked/);
  });

  it("shows tool calls as progress, failovers as warnings, and how a run ended", () => {
    expect(feedLine(event("tool_call", { name: "balances" }))?.text).toBe("checking balances…");
    expect(feedLine(event("tool_call", { name: "new-tool" }))?.text).toBe("using new-tool…");
    expect(
      feedLine(
        event("llm_failover", {
          from: "openai-compatible:meta/muse-glimmer-30b",
          to: "anthropic:claude-opus-5-5",
          reason: "NVIDIA meta/muse-glimmer-30b did not respond within 60 s (2 tries)",
        }),
      ),
    ).toMatchObject({
      tone: "warn",
      text: "model openai-compatible:meta/muse-glimmer-30b failed; switched to anthropic:claude-opus-5-5 (NVIDIA meta/muse-glimmer-30b did not respond within 60 s (2 tries))",
    });
    expect(feedLine(event("run_end", { reason: "done" }))).toMatchObject({
      text: "run finished",
      tone: "neutral",
    });
    expect(feedLine(event("run_end", { reason: "max_steps" }))).toMatchObject({
      text: "run stopped: step limit reached",
      tone: "bad",
    });
    expect(feedLine(event("run_end", { reason: "done", text: "Bought SOL." }))?.text).toBe(
      "summary: Bought SOL.",
    );
  });

  it("leaves out noisy internals", () => {
    expect(feedLine(event("llm", { text: "thinking" }))).toBeUndefined();
    expect(feedLine(event("tool_result", { ok: true }))).toBeUndefined();
  });
});

describe("runStatus", () => {
  const e = (type: string, run: string, fields: Record<string, unknown> = {}) =>
    event(type, { run, ...fields });

  it("follows the first run after the click to its end", () => {
    expect(runStatus([])).toEqual({ state: "waiting" });
    const started = [e("run_start", "r1"), e("tool_call", "r1", { name: "balances" })];
    expect(runStatus(started)).toEqual({ state: "running", run: "r1" });
    expect(
      runStatus([...started, e("run_end", "r1", { reason: "done", text: "All good." })]),
    ).toEqual({ state: "finished", run: "r1", text: "All good." });
  });

  it("fails with the run's last error, ignoring other runs", () => {
    expect(
      runStatus([
        e("run_start", "r1"),
        e("error", "r0", { message: "someone else's" }),
        e("error", "r1", { message: "NVIDIA meta/muse-glimmer-30b did not respond" }),
        e("run_end", "r1", { reason: "error" }),
      ]),
    ).toEqual({
      state: "failed",
      run: "r1",
      reason: "NVIDIA meta/muse-glimmer-30b did not respond",
    });
    expect(runStatus([e("run_start", "r2"), e("run_end", "r2", { reason: "max_steps" })])).toEqual({
      state: "failed",
      run: "r2",
      reason: "step limit reached",
    });
  });
});

describe("the words an owner reads", () => {
  it("names where an agent runs without the manifest's terms", () => {
    expect(whereItRuns({ runtime: "hosted" })).toBe("hosted");
    expect(whereItRuns({ runtime: "external", custody: "server" })).toBe("your AI");
    expect(whereItRuns({ runtime: "external" })).toBe("your AI, your key");
    expect(whereItRuns({ runtime: "local" })).toBe("on your machine");
  });

  it("says day, week and month for an allowance's period", () => {
    expect(["daily", "weekly", "monthly", undefined].map(periodWord)).toEqual([
      "day",
      "week",
      "month",
      "period",
    ]);
  });

  it("calls a held action a request waiting for approval, and a pause by its own words", () => {
    const line = (event: Record<string, unknown>) =>
      feedLine({
        seq: 1,
        agentName: "night-owl",
        at: "2026-10-05T00:00:00.000Z",
        ...event,
      } as never);
    expect(line({ type: "draft_created", summary: "swap 6 USDC", usd: 6 })?.text).toMatch(
      /^waiting for your approval: swap 6 USDC/,
    );
    expect(
      line({ type: "approval", kind: "pause", status: "paused", summary: "paused from Telegram" }),
    ).toMatchObject({ text: "paused from Telegram", tone: "warn" });
    expect(
      line({ type: "approval", kind: "topup", status: "pulled", summary: "10 USDC" })?.text,
    ).toBe("top-up pulled: 10 USDC");
  });
});
