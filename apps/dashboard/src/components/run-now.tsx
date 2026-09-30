"use client";
import { useEffect, useRef, useState } from "react";
import { type ActivityEvent, api } from "@/lib/api";
import { runStatus } from "@/lib/format";

const POLL_MS = 2000;
const GIVE_UP_MS = 5 * 60_000;

type State =
  | { kind: "idle" | "starting" | "running" }
  | { kind: "finished"; text?: string }
  | { kind: "failed"; reason: string };

/**
 * Starts a hosted agent's run now, then follows that run in the activity log:
 * Running… → Finished (with the summary) or Failed (with the reason).
 */
export function RunNow({ name, nextRun }: { name: string; nextRun?: number | null }) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  async function go() {
    setState({ kind: "starting" });
    try {
      const newest = (await api.activity(undefined, name)).events[0]?.seq ?? 0;
      const { started } = await api.runNow(name);
      if (!started) {
        setState({
          kind: "failed",
          reason: "The server is still loading this agent; try again in a moment.",
        });
        return;
      }
      setState({ kind: "running" });
      await follow(newest);
    } catch (e) {
      if (alive.current) setState({ kind: "failed", reason: (e as Error).message });
    }
  }

  async function follow(after: number) {
    const seen: ActivityEvent[] = [];
    let last = after;
    const deadline = Date.now() + GIVE_UP_MS;
    while (alive.current && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      const { events } = await api.activity(last, name).catch(() => ({ events: [] }));
      seen.push(...events);
      last = Math.max(last, ...events.map((e) => e.seq));
      const status = runStatus(seen);
      if (!alive.current) return;
      if (status.state === "finished") {
        setState({ kind: "finished", ...(status.text ? { text: status.text } : {}) });
        return;
      }
      if (status.state === "failed") {
        setState({ kind: "failed", reason: status.reason });
        return;
      }
    }
    if (alive.current) {
      setState({ kind: "failed", reason: "Still running after 5 minutes; see the activity feed." });
    }
  }

  const busy = state.kind === "starting" || state.kind === "running";
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <button
        type="button"
        onClick={() => void go()}
        disabled={busy}
        className="rounded-lg border border-accent px-3 py-1.5 font-semibold text-accent disabled:opacity-50"
      >
        {state.kind === "starting"
          ? "Starting…"
          : state.kind === "running"
            ? "Running…"
            : "Run now"}
      </button>
      {state.kind === "finished" && (
        <span className="min-w-0 break-words text-good">
          Finished ✓{state.text ? ` ${state.text}` : ""}
        </span>
      )}
      {state.kind === "failed" && (
        <span className="min-w-0 break-words text-bad">Failed: {state.reason}</span>
      )}
      {nextRun && !busy ? (
        <span className="text-muted">
          next scheduled run {new Date(nextRun).toLocaleTimeString()}
        </span>
      ) : null}
    </div>
  );
}
