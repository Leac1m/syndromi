"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/api";

/** Removes an unfunded agent (the server refuses while anything is delegated to it). */
export function RemoveAgent({ name }: { name: string }) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "confirm" | "removing">("idle");
  const [error, setError] = useState<string>();
  async function remove() {
    setState("removing");
    setError(undefined);
    try {
      await api.removeAgent(name);
      router.push("/");
    } catch (e) {
      setState("idle");
      setError((e as Error).message);
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      {state === "idle" ? (
        <button
          type="button"
          onClick={() => setState("confirm")}
          className="rounded-lg border border-line px-3 py-1.5 text-muted hover:text-bad"
        >
          Remove agent
        </button>
      ) : (
        <>
          <span>Remove {name}? Its name becomes free again.</span>
          <button
            type="button"
            onClick={() => void remove()}
            disabled={state === "removing"}
            className="rounded-lg border border-bad px-3 py-1.5 font-semibold text-bad disabled:opacity-50"
          >
            {state === "removing" ? "Removing…" : "Remove"}
          </button>
          <button type="button" onClick={() => setState("idle")} className="text-muted underline">
            Cancel
          </button>
        </>
      )}
      {error && <span className="text-bad">{error}</span>}
    </div>
  );
}
