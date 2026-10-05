// The guided run, read back from the tour agent's activity: which of its five moves has
// happened, which one is waiting for the owner, and what the agent last said. The card on the
// overview is drawn from this, so it shows the run as it happens and survives a page reload.
import type { ActivityEvent } from "./api";

export const TOUR_MOVES = ["pull", "swap-small", "swap-large", "transfer", "topup"] as const;
export type TourMoveKey = (typeof TOUR_MOVES)[number];

/**
 * todo: not reached yet. working: the agent is on it (or, once approved, executing it).
 * waiting: held for the owner. done: it went through. blocked: the rules refused it.
 * declined: the owner said no or never answered. failed: something went wrong.
 */
export type TourMoveState =
  | "todo"
  | "working"
  | "waiting"
  | "done"
  | "blocked"
  | "declined"
  | "failed";

export type TourMove = {
  key: TourMoveKey;
  state: TourMoveState;
  /** The held request's id (`d_…` or `t_…`), while and after it waits for the owner. */
  requestId?: string;
  signature?: string;
  /** Why it was blocked or failed, in the server's words. */
  detail?: string;
};

export type TourProgress = {
  /** Whether the agent has ever run. */
  started: boolean;
  running: boolean;
  moves: TourMove[];
  /** The agent's latest line of narration. */
  saying?: string;
  /** The agent's closing words, once the run is over. */
  summary?: string;
};

const TOOL_MOVE: Record<string, TourMoveKey> = {
  "pull-allowance": "pull",
  "propose-tx": "transfer",
  "request-topup": "topup",
};

/** `events` in any order; only the latest run counts. */
export function tourProgress(events: readonly ActivityEvent[]): TourProgress {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const start = ordered.map((e) => e.type).lastIndexOf("run_start");
  const moves: TourMove[] = TOUR_MOVES.map((key) => ({ key, state: "todo" }));
  if (start < 0) return { started: false, running: false, moves };

  const byKey = (key: TourMoveKey) => moves.find((m) => m.key === key) as TourMove;
  let current: TourMove | undefined;
  let swaps = 0;
  let running = true;
  let saying: string | undefined;
  let summary: string | undefined;

  for (const e of ordered.slice(start + 1)) {
    switch (e.type) {
      case "llm":
        saying = String(e.text ?? "");
        break;
      case "tool_call": {
        const name = String(e.name);
        const key =
          name === "orca-swap" ? (swaps++ === 0 ? "swap-small" : "swap-large") : TOOL_MOVE[name];
        if (!key) break; // balances and quotes are not moves
        current = byKey(key);
        current.state = "working";
        break;
      }
      case "tx_sent":
        if (current) {
          current.state = "done";
          if (typeof e.signature === "string") current.signature = e.signature;
        }
        break;
      case "draft_created":
        if (current) {
          current.state = "waiting";
          current.requestId = String(e.draftId);
        }
        break;
      case "topup_requested":
        if (current) {
          current.state = "waiting";
          current.requestId = String(e.requestId);
        }
        break;
      case "blocked":
        if (current) {
          current.state = "blocked";
          if (Array.isArray(e.reasons)) current.detail = (e.reasons as string[]).join("; ");
        }
        break;
      case "approval": {
        // Only this run's requests: an old one may still expire or be answered meanwhile.
        const move = moves.find((m) => m.requestId && m.requestId === e.id);
        if (!move) break;
        const status = String(e.status);
        if (status === "executed" || status === "pulled") {
          move.state = "done";
          if (typeof e.signature === "string") move.signature = e.signature;
        } else if (status === "approved") move.state = "working";
        else if (status === "rejected" || status === "expired") move.state = "declined";
        else if (status === "failed" || status === "stale") {
          move.state = "failed";
          if (typeof e.error === "string") move.detail = e.error;
        }
        break;
      }
      case "tool_result":
        if (e.ok === false && current?.state === "working") {
          current.state = "failed";
          current.detail = String(e.error ?? "");
        }
        break;
      case "error":
        if (current?.state === "working") {
          current.state = "failed";
          current.detail = String(e.message ?? "");
        }
        break;
      case "run_end":
        running = false;
        if (typeof e.text === "string") summary = e.text;
        break;
    }
  }
  return {
    started: true,
    running,
    moves,
    ...(saying ? { saying } : {}),
    ...(summary ? { summary } : {}),
  };
}
