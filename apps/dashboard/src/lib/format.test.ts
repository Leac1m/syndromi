import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "./api";
import { feedLine } from "./format";

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
      text: "draft executed: swap 15 USDC",
    });
    expect(
      feedLine(event("approval", { kind: "kill", status: "revoked", summary: "all" }))?.text,
    ).toMatch(/^kill switch revoked/);
  });

  it("leaves out noisy internals", () => {
    expect(feedLine(event("llm", { text: "thinking" }))).toBeUndefined();
    expect(feedLine(event("tool_result", { ok: true }))).toBeUndefined();
  });
});
