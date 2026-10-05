"use client";
// The guided run: the shortest way for a new owner to see what the rules do, with nothing to
// install and no AI to connect. It walks through getting test funds, creating a scripted agent
// (its "model" is a fixed list of tool calls that goes through the real policy), funding it, and
// running it once. Devnet only.
import Link from "next/link";
import { type ReactNode, useState } from "react";
import { api, FAUCET_OFF, type Overview, TOUR_TEMPLATE, tourAgentName } from "@/lib/api";
import { ActionPanel } from "./action-panel";
import { RunNow } from "./run-now";
import { Card } from "./ui";

/** What the tour agent's allowance needs in the owner's wallet, and SOL enough to fund it. */
const NEED_USDC = 20;
const NEED_SOL = 0.05;

const EXPECT: [string, string][] = [
  ["Pulls 10 test USDC from its allowance", "goes through: the allowance covers it"],
  ["Swaps 3 USDC for JitoSOL", "goes through: it is under your $5 approval threshold"],
  ["Tries to swap 6 USDC", "waits for you under Pending approvals: it is above the threshold"],
  ["Tries to send 1 USDC to a stranger", "BLOCKED: you only allowed its own wallet"],
  ["Asks you for a top-up", "waits for you: only you can raise its budget"],
];

export function GuidedTour({ data, onChange }: { data: Overview; onChange(): void }) {
  const tour = data.agents.find((a) => a.script === "tour");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // For owners who are just starting, and for as long as their tour agent exists.
  if (data.cluster !== "devnet" || (data.agents.length > 0 && !tour)) return null;

  const hasSol = data.bag.sol >= NEED_SOL;
  const hasUsdc = data.bag.usdc >= NEED_USDC;
  const attempt = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await work();
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const create = () =>
    attempt(async () => {
      const template = (await api.templates()).find((t) => t.name === TOUR_TEMPLATE);
      if (!template) throw new Error("This server has no guided tour.");
      await api.createHosted(TOUR_TEMPLATE, "devnet", {
        ...template.manifest,
        name: tourAgentName(data.owner),
      });
    });

  const button =
    "rounded-lg bg-accent px-3 py-1.5 font-semibold text-accent-fg disabled:opacity-50";
  return (
    <Card title="Try a guided run">
      <p className="text-sm text-muted">
        See the rules at work before you connect anything. A scripted agent (no AI, no keys) makes
        five moves with test tokens, and each one meets a different rule.
      </p>
      <ol className="mt-4 space-y-3 text-sm">
        <Step n={1} done={hasSol} title="Get a little devnet SOL for network fees">
          <a
            className="text-accent underline"
            href="https://faucet.solana.com"
            target="_blank"
            rel="noreferrer"
          >
            Open Solana's faucet
          </a>{" "}
          and send some to your wallet. This page updates on its own.
        </Step>
        <Step n={2} done={hasUsdc} title={`Get ${NEED_USDC} or more test USDC`}>
          {data.faucet ? (
            <button
              type="button"
              className={button}
              disabled={busy || Boolean(data.faucet.nextAt)}
              onClick={() => void attempt(() => api.faucet())}
            >
              {busy ? "Sending…" : `Get ${data.faucet.amount} test USDC`}
            </button>
          ) : (
            <span className="text-warn">{FAUCET_OFF}</span>
          )}
        </Step>
        <Step n={3} done={Boolean(tour)} title="Create the tour agent" locked={!hasSol || !hasUsdc}>
          <button type="button" className={button} disabled={busy} onClick={() => void create()}>
            {busy ? "Creating…" : "Create it"}
          </button>
        </Step>
        <Step
          n={4}
          done={Boolean(tour?.funded)}
          title="Give it a budget: 20 test USDC a week, signed in your wallet"
          locked={!tour}
        >
          {tour && (
            <ActionPanel
              path={`/actions/fund-agent/${encodeURIComponent(tour.name)}`}
              compact
              onDone={onChange}
            />
          )}
        </Step>
        <Step n={5} title="Run it, and watch the activity below" locked={!tour?.funded}>
          {tour && <RunNow name={tour.name} />}
          <ul className="mt-3 space-y-1.5">
            {EXPECT.map(([move, outcome]) => (
              <li key={move} className="flex gap-2">
                <span className="text-accent">•</span>
                <span>
                  {move}: <span className="text-muted">{outcome}.</span>
                </span>
              </li>
            ))}
          </ul>
        </Step>
        <Step n={6} title="Now do it with your own AI" locked={!tour?.funded}>
          <Link href="/app/agents/new" className="text-accent underline">
            Create an agent for Claude, Cursor or any MCP client
          </Link>
          . The same rules apply to whatever it decides to do.
        </Step>
      </ol>
      {error && <p className="mt-3 text-sm text-bad">{error}</p>}
    </Card>
  );
}

/** One numbered step: a tick when done, its controls when it is the owner's turn, greyed until then. */
function Step({
  n,
  title,
  done,
  locked,
  children,
}: {
  n: number;
  title: string;
  done?: boolean;
  locked?: boolean;
  children: ReactNode;
}) {
  return (
    <li className={`flex gap-3 ${locked ? "opacity-50" : ""}`}>
      <span
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${done ? "bg-good text-white" : "bg-line"}`}
        aria-hidden
      >
        {done ? "✓" : n}
      </span>
      <div className="min-w-0 flex-1">
        <p className={`font-medium ${done ? "text-muted" : ""}`}>
          {title}
          {done && <span className="sr-only"> (done)</span>}
        </p>
        {!done && !locked && <div className="mt-1.5">{children}</div>}
      </div>
    </li>
  );
}
