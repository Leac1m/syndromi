"use client";
import { useState } from "react";
import { api } from "@/lib/api";

/** Starts a hosted agent's run now; its steps then appear in the activity feed. */
export function RunNow({ name, nextRun }: { name: string; nextRun?: number | null }) {
  const [state, setState] = useState<"idle" | "starting" | "started" | "error">("idle");
  const [error, setError] = useState<string>();
  async function go() {
    setState("starting");
    setError(undefined);
    try {
      const { started } = await api.runNow(name);
      setState(started ? "started" : "error");
      if (!started) setError("The server is still loading this agent; try again in a moment.");
    } catch (e) {
      setState("error");
      setError((e as Error).message);
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <button
        type="button"
        onClick={() => void go()}
        disabled={state === "starting"}
        className="rounded-lg border border-accent px-3 py-1.5 font-semibold text-accent disabled:opacity-50"
      >
        {state === "starting" ? "Starting…" : state === "started" ? "Run started ✓" : "Run now"}
      </button>
      {nextRun ? (
        <span className="text-muted">
          next scheduled run {new Date(nextRun).toLocaleTimeString()}
        </span>
      ) : null}
      {error && <span className="text-bad">{error}</span>}
    </div>
  );
}
