"use client";
// Runs one of the server's Solana Actions inline: shows the card, signs each step in Phantom,
// follows chained steps ("Step 2 of 2"), and reports completion.
import { useEffect, useState } from "react";
import { type Card as ActionCard, getCard, runStep } from "@/lib/actions";
import { SERVER } from "@/lib/config";
import { useApp } from "./providers";

export function ActionPanel({
  path,
  compact,
  onDone,
  danger,
}: {
  path: string;
  compact?: boolean;
  onDone?: (card: ActionCard) => void;
  danger?: boolean;
}) {
  const app = useApp();
  const [card, setCard] = useState<ActionCard>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    setCard(undefined);
    getCard(SERVER, path).then(setCard, (e: Error) => setError(e.message));
  }, [path]);

  async function go() {
    const signer = app.signer();
    if (!card || !signer) return;
    if (
      app.network === "mainnet" &&
      window.prompt('Type "mainnet" to sign with real funds') !== "mainnet"
    )
      return;
    setBusy(true);
    setError(undefined);
    try {
      const next = await runStep(SERVER, card, signer);
      setCard(next);
      if (next.type === "completed") onDone?.(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!card) return <p className="text-sm text-muted">{error ?? "Loading…"}</p>;
  const done = card.type === "completed";
  const button = card.links?.actions?.[0]?.label ?? card.label;
  return (
    <div className={compact ? "space-y-2" : "space-y-3"}>
      {!compact && <h3 className="font-semibold">{card.title}</h3>}
      <p className="whitespace-pre-line text-sm text-muted">{card.description}</p>
      <button
        type="button"
        onClick={() => void go()}
        disabled={busy || done || card.disabled}
        className={`w-full rounded-lg px-4 py-2.5 font-semibold text-white disabled:opacity-50 ${danger ? "bg-bad" : "bg-accent"}`}
      >
        {busy ? "Waiting for Phantom…" : done ? card.label : button}
      </button>
      {error && <p className="text-sm text-bad">{error}</p>}
    </div>
  );
}
