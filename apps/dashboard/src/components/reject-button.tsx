"use client";
import { useState } from "react";
import { api } from "@/lib/api";

/** Reject a held request. Approving needs the wallet; saying no does not. */
export function RejectButton({ id, onDone }: { id: string; onDone?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const go = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await api.reject(id);
      onDone?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-2 text-sm">
      <button
        type="button"
        onClick={() => void go()}
        disabled={busy}
        className="rounded-lg border border-line px-3 py-1.5 font-semibold text-muted disabled:opacity-50"
      >
        {busy ? "Rejecting…" : "Reject"}
      </button>
      {error && <span className="text-bad">{error}</span>}
    </span>
  );
}
