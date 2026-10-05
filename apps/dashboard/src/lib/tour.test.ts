import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "./api";
import { tourProgress } from "./tour";

let seq = 0;
const ev = (type: string, fields: Record<string, unknown> = {}): ActivityEvent => ({
  seq: ++seq,
  agentName: "tour-abc",
  type,
  at: "2026-10-05T00:00:00.000Z",
  ...fields,
});
const states = (events: ActivityEvent[]) =>
  Object.fromEntries(tourProgress(events).moves.map((m) => [m.key, m.state]));

/** A run up to the point where the larger swap is held for the owner. */
const untilHeld = () => [
  ev("run_start"),
  ev("llm", { text: "First I look at what I have to work with." }),
  ev("tool_call", { name: "balances" }),
  ev("tool_call", { name: "pull-allowance" }),
  ev("tx_sent", { tool: "pull-allowance", signature: "sigPull" }),
  ev("tool_call", { name: "orca-quote" }),
  ev("tool_call", { name: "orca-swap" }),
  ev("tx_sent", { tool: "orca-swap", signature: "sigSwap" }),
  ev("llm", { text: "Now a larger swap, 6 USDC." }),
  ev("tool_call", { name: "orca-swap" }),
  ev("draft_created", { draftId: "d_1" }),
];

describe("tourProgress", () => {
  it("has nothing to show before the first run", () => {
    expect(tourProgress([])).toMatchObject({ started: false, running: false });
    expect(states([])).toEqual({
      pull: "todo",
      "swap-small": "todo",
      "swap-large": "todo",
      transfer: "todo",
      topup: "todo",
    });
  });

  it("follows the run to the move that waits for the owner, whatever order events arrive in", () => {
    const events = untilHeld();
    const progress = tourProgress([...events].reverse());
    expect(progress).toMatchObject({
      started: true,
      running: true,
      saying: "Now a larger swap, 6 USDC.",
    });
    expect(states(events)).toEqual({
      pull: "done",
      "swap-small": "done",
      "swap-large": "waiting",
      transfer: "todo",
      topup: "todo",
    });
    expect(progress.moves[2]).toMatchObject({ requestId: "d_1" });
    expect(progress.moves[0]).toMatchObject({ signature: "sigPull" });
  });

  it("carries on after an approval: executing, executed, then blocked and the top-up", () => {
    const events = untilHeld();
    events.push(ev("approval", { kind: "draft", id: "d_1", status: "approved" }));
    expect(states(events)["swap-large"]).toBe("working");
    events.push(
      ev("approval", { kind: "draft", id: "d_1", status: "executed", signature: "sigBig" }),
    );
    events.push(ev("tool_call", { name: "propose-tx" }));
    events.push(ev("blocked", { reasons: ["token destination X not in allowlist"] }));
    events.push(ev("tool_call", { name: "request-topup" }));
    events.push(ev("topup_requested", { requestId: "t_1" }));
    expect(states(events)).toEqual({
      pull: "done",
      "swap-small": "done",
      "swap-large": "done",
      transfer: "blocked",
      topup: "waiting",
    });
    expect(tourProgress(events).moves[3]?.detail).toMatch(/not in allowlist/);
    events.push(ev("approval", { kind: "topup", id: "t_1", status: "pulled" }));
    events.push(ev("run_end", { reason: "done", text: "Tour finished." }));
    expect(tourProgress(events)).toMatchObject({ running: false, summary: "Tour finished." });
    expect(states(events).topup).toBe("done");
  });

  it("ends at a rejection, leaving the later moves untouched", () => {
    const events = untilHeld();
    events.push(ev("approval", { kind: "draft", id: "d_1", status: "rejected" }));
    events.push(ev("run_end", { reason: "done", text: "You rejected that, so I stop here." }));
    expect(states(events)).toMatchObject({
      "swap-large": "declined",
      transfer: "todo",
      topup: "todo",
    });
    expect(tourProgress(events).running).toBe(false);
  });

  it("shows only the latest run, and ignores an old request settling during it", () => {
    const first = untilHeld();
    first.push(ev("approval", { kind: "draft", id: "d_1", status: "rejected" }), ev("run_end"));
    const second = [ev("run_start"), ev("tool_call", { name: "pull-allowance" })];
    // The first run's request expires while the second run is under way.
    second.push(ev("approval", { kind: "draft", id: "d_1", status: "expired" }));
    expect(states([...first, ...second])).toEqual({
      pull: "working",
      "swap-small": "todo",
      "swap-large": "todo",
      transfer: "todo",
      topup: "todo",
    });
  });

  it("marks a move that could not be done", () => {
    const events = [
      ev("run_start"),
      ev("tool_call", { name: "pull-allowance" }),
      ev("tool_result", { name: "pull-allowance", ok: false, error: "not enough allowance left" }),
    ];
    expect(tourProgress(events).moves[0]).toMatchObject({
      state: "failed",
      detail: "not enough allowance left",
    });
  });
});
