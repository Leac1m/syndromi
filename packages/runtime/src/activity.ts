// Structured activity log: every step of a run, as one JSON object per line. The dashboard's
// feed (Day 5) reads the same events from the server; locally they land in activity.jsonl.
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { toJson } from "./json.js";

export type ActivityType =
  | "run_start"
  | "llm"
  | "llm_failover"
  | "tool_call"
  | "tool_result"
  | "decision"
  | "tx_sent"
  | "draft_created"
  | "blocked"
  | "topup_requested"
  | "error"
  | "run_end";

export type ActivityEvent = {
  at: string;
  agent: string;
  run: string;
  type: ActivityType;
  [field: string]: unknown;
};

export type ActivitySink = (event: ActivityEvent) => void | Promise<void>;

export class ActivityLog {
  readonly run = crypto.randomUUID().slice(0, 8);
  constructor(
    readonly agent: string,
    private readonly sinks: ActivitySink[],
  ) {}

  async emit(type: ActivityType, fields: Record<string, unknown> = {}): Promise<ActivityEvent> {
    const event: ActivityEvent = {
      at: new Date().toISOString(),
      agent: this.agent,
      run: this.run,
      type,
      ...fields,
    };
    for (const sink of this.sinks) await sink(event);
    return event;
  }
}

export function fileSink(path: string): ActivitySink {
  let ready: Promise<unknown> | undefined;
  return async (event) => {
    ready ??= mkdir(dirname(path), { recursive: true });
    await ready;
    await appendFile(path, `${toJson(event)}\n`);
  };
}

export function memorySink(): ActivitySink & { events: ActivityEvent[] } {
  const events: ActivityEvent[] = [];
  return Object.assign((event: ActivityEvent) => void events.push(event), { events });
}

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/** Human-readable lines for the terminal. */
export function consoleSink(write: (line: string) => void = console.log): ActivitySink {
  return (e) => {
    const time = e.at.slice(11, 19);
    const line = describe(e);
    if (line) write(`${DIM}${time}${RESET} ${line}`);
  };
}

function describe(e: ActivityEvent): string | undefined {
  switch (e.type) {
    case "run_start":
      return `▶ ${e.agent} on ${e.cluster} (${e.model}), run ${e.run}`;
    case "llm":
      return `${DIM}💭 ${oneLine(String(e.text), 300)}${RESET}`;
    case "tool_call":
      return `→ ${e.name} ${oneLine(toJson(e.input), 160)}`;
    case "tool_result":
      return e.ok
        ? `${DIM}  ← ${oneLine(String(e.preview), 200)}${RESET}`
        : `${YELLOW}  ← error: ${oneLine(String(e.error), 300)}${RESET}`;
    case "decision": {
      const color = e.verdict === "allow" ? GREEN : e.verdict === "block" ? RED : YELLOW;
      const usd = typeof e.usd === "number" ? ` ($${e.usd.toFixed(2)})` : "";
      return `  ${color}${String(e.verdict).toUpperCase()}${RESET} ${e.summary}${usd}`;
    }
    case "tx_sent":
      return `  ${GREEN}✓ sent${RESET} ${e.explorer ?? e.signature}`;
    case "draft_created":
      return `  ${YELLOW}⏸ draft ${e.draftId} awaits owner approval${RESET}`;
    case "blocked":
      return `  ${RED}✗ BLOCKED: ${(e.reasons as string[]).join("; ")}${RESET}`;
    case "topup_requested":
      return `  ${YELLOW}⏸ top-up request ${e.requestId}: ${e.summary}${RESET}`;
    case "llm_failover":
      return `${YELLOW}↪ ${e.from} failed; switched to ${e.to}: ${oneLine(String(e.reason), 200)}${RESET}`;
    case "error":
      return `${RED}! ${e.message}${RESET}`;
    case "run_end":
      return `■ done after ${e.steps} step(s) (${e.reason})${e.text ? `: ${oneLine(String(e.text), 400)}` : ""}`;
  }
}

const oneLine = (s: string, max: number) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
