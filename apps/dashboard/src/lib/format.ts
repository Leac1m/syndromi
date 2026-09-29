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

const money = (usd: unknown) => (typeof usd === "number" ? ` ($${usd.toFixed(2)})` : "");

export function feedLine(e: ActivityEvent): FeedLine | undefined {
  const base = { key: String(e.seq), at: e.at, agent: e.agentName };
  const sig = typeof e.signature === "string" ? e.signature : undefined;
  switch (e.type) {
    case "run_start":
      return { ...base, text: "started a run", tone: "neutral" };
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
        text: `drafted for approval: ${String(e.summary)}${money(e.usd)}`,
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
    case "run_end":
      return e.text ? { ...base, text: `summary: ${String(e.text)}`, tone: "neutral" } : undefined;
    case "approval": {
      const status = String(e.status);
      const tone: Tone = ["executed", "approved", "pulled", "funded"].includes(status)
        ? "good"
        : ["failed", "stale", "revoked"].includes(status)
          ? "bad"
          : "neutral";
      const what =
        e.kind === "kill" ? "kill switch" : e.kind === "fund" ? "funding" : String(e.kind);
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
