// Activity events → one readable line each for the feed. Noisy internals (LLM text, raw tool
// results) are left out; decisions, transactions, drafts, BLOCKED and approvals stay.
import type { ActivityEvent } from "./api";

export type Tone = "neutral" | "good" | "warn" | "bad";
export type FeedLine = {
  key: string;
  at: string;
  agent: string;
  text: string;
  tone: Tone;
  signature?: string;
};

/** What a tool call looks like from the outside, as a progress line. */
const TOOL_PROGRESS: Record<string, string> = {
  balances: "checking balances",
  "pyth-price": "reading prices",
  "jupiter-quote": "quoting a swap",
  "jupiter-swap": "preparing a swap",
  "pull-allowance": "pulling its allowance",
  "request-topup": "asking for a top-up",
  "propose-tx": "preparing a transfer",
  "yield-data": "reading yield data",
};

/** What each kind of owner decision is called in the feed. */
const APPROVAL_KINDS: Record<string, string> = {
  kill: "kill switch",
  fund: "funding",
  draft: "approval request",
  topup: "top-up",
  token: "access",
};

/** Where an agent runs, as the owner would say it. */
export function whereItRuns(agent: { runtime: string; custody?: string }): string {
  if (agent.runtime === "hosted") return "hosted";
  if (agent.runtime === "external")
    return agent.custody === "server" ? "your AI" : "your AI, your key";
  return "on your machine";
}

/** "week" for a weekly allowance, and so on. */
export const periodWord = (period: string | undefined) =>
  ({ daily: "day", weekly: "week", monthly: "month" })[period ?? ""] ?? "period";

const STOP_REASONS: Record<string, string> = {
  max_steps: "step limit reached",
  refused: "the model declined",
  error: "an error (see above)",
};

const money = (usd: unknown) => (typeof usd === "number" ? ` ($${usd.toFixed(2)})` : "");

export function feedLine(e: ActivityEvent): FeedLine | undefined {
  const base = { key: String(e.seq), at: e.at, agent: e.agentName };
  const sig = typeof e.signature === "string" ? e.signature : undefined;
  switch (e.type) {
    case "run_start":
      return { ...base, text: "started a run", tone: "neutral" };
    case "tool_call":
      return {
        ...base,
        text: `${TOOL_PROGRESS[String(e.name)] ?? `using ${String(e.name)}`}…`,
        tone: "neutral",
      };
    case "llm_failover":
      return {
        ...base,
        text: `model ${String(e.from)} failed; switched to ${String(e.to)} (${String(e.reason)})`,
        tone: "warn",
      };
    case "decision": {
      const verdict = String(e.verdict);
      if (verdict === "block") return undefined; // the "blocked" event says it better
      const tone: Tone = verdict === "allow" ? "good" : "warn";
      const word = verdict === "allow" ? "allowed" : "needs your approval";
      return { ...base, text: `${word}: ${String(e.summary)}${money(e.usd)}`, tone };
    }
    case "tx_sent":
      return {
        ...base,
        text: `sent: ${String(e.summary ?? e.tool)}`,
        tone: "good",
        ...(sig ? { signature: sig } : {}),
      };
    case "draft_created":
      return {
        ...base,
        text: `waiting for your approval: ${String(e.summary)}${money(e.usd)}`,
        tone: "warn",
      };
    case "blocked": {
      const reasons = Array.isArray(e.reasons) ? (e.reasons as string[]).join("; ") : "";
      return { ...base, text: `BLOCKED: ${String(e.summary ?? e.tool)} — ${reasons}`, tone: "bad" };
    }
    case "topup_requested":
      return { ...base, text: `asked for a top-up: ${String(e.summary)}`, tone: "warn" };
    case "error":
      return { ...base, text: `error: ${String(e.message)}`, tone: "bad" };
    case "run_end": {
      if (e.text) return { ...base, text: `summary: ${String(e.text)}`, tone: "neutral" };
      const why = STOP_REASONS[String(e.reason)];
      return why
        ? { ...base, text: `run stopped: ${why}`, tone: "bad" }
        : { ...base, text: "run finished", tone: "neutral" };
    }
    case "approval": {
      const status = String(e.status);
      // A pause or resume says it all in its summary.
      if (e.kind === "pause") {
        return { ...base, text: String(e.summary), tone: status === "paused" ? "warn" : "good" };
      }
      const tone: Tone = ["executed", "approved", "pulled", "funded"].includes(status)
        ? "good"
        : ["failed", "stale", "revoked"].includes(status)
          ? "bad"
          : "neutral";
      const what = APPROVAL_KINDS[String(e.kind)] ?? String(e.kind);
      return {
        ...base,
        text: `${what} ${status}: ${String(e.summary)}`,
        tone,
        ...(sig ? { signature: sig } : {}),
      };
    }
    default:
      return undefined;
  }
}

export type RunStatus =
  | { state: "waiting" }
  | { state: "running"; run: string }
  | { state: "finished"; run: string; text?: string }
  | { state: "failed"; run: string; reason: string };

/**
 * Where the first run in `events` (oldest first, all after the Run now click) has got to. A run
 * fails when it ends with reason "error"; its reason is the run's last error message.
 */
export function runStatus(events: ActivityEvent[]): RunStatus {
  const start = events.find((e) => e.type === "run_start");
  if (!start) return { state: "waiting" };
  const run = String(start.run);
  const mine = events.filter((e) => e.run === start.run);
  const end = mine.find((e) => e.type === "run_end");
  if (!end) return { state: "running", run };
  if (end.reason === "done") {
    return { state: "finished", run, ...(end.text ? { text: String(end.text) } : {}) };
  }
  const lastError = mine.findLast((e) => e.type === "error");
  const reason = lastError
    ? String(lastError.message)
    : (STOP_REASONS[String(end.reason)] ?? String(end.reason));
  return { state: "failed", run, reason };
}
