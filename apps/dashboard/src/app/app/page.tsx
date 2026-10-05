"use client";
import Link from "next/link";
import { useState } from "react";
import { ActionPanel } from "@/components/action-panel";
import { ActivityFeed } from "@/components/activity-feed";
import { useApp } from "@/components/providers";
import { RunNow } from "@/components/run-now";
import { TelegramCard } from "@/components/telegram-card";
import { Card } from "@/components/ui";
import { api, type Overview as OverviewData, ServerUnreachable } from "@/lib/api";
import { usePoll } from "@/lib/use-poll";

const UNREACHABLE = new ServerUnreachable().message;

export default function Overview() {
  const app = useApp();
  const { data, error, refresh } = usePoll(() => api.overview(app.network), 5000, [
    app.network,
    app.owner,
  ]);
  // The shell already says so when the server stops answering; only other errors are shown here.
  const unreachable = error === UNREACHABLE;

  const symbol = data?.bag.symbol ?? "USDC";
  const allocated = Object.entries(data?.allocatedPerPeriod ?? {})
    .map(([period, amount]) => `${amount} ${symbol} ${period}`)
    .join(" + ");
  const pendingCount = (data?.pending.drafts.length ?? 0) + (data?.pending.topups.length ?? 0);

  return (
    <div className="grid gap-4 md:grid-cols-3">
      {error && !unreachable && <p className="text-sm text-bad md:col-span-3">Server: {error}</p>}

      <Card title="Bag">
        <p className="text-3xl font-bold tabular-nums">
          {data ? data.bag.usdc.toLocaleString() : "…"}{" "}
          <span className="text-base font-medium text-muted">{symbol}</span>
        </p>
        <p className="mt-1 text-sm text-muted">
          {data ? `${data.bag.sol.toFixed(4)} SOL for fees` : ""}
        </p>
        <p className="mt-3 text-sm">Allocated: {allocated || "nothing yet"}</p>
        {app.network === "devnet" && data && (
          <TestFunds faucet={data.faucet} sol={data.bag.sol} onClaimed={refresh} />
        )}
      </Card>

      <Card
        title="Agents"
        action={
          <Link
            href="/app/agents/new"
            className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-accent-fg"
          >
            New agent
          </Link>
        }
      >
        <div className="md:col-span-2">
          {!data?.agents.length && (
            <p className="text-sm text-muted">No agents on {app.network} yet.</p>
          )}
          <ul className="divide-y divide-line">
            {data?.agents.map((a) => (
              <li key={a.name} className="py-2.5">
                <Link
                  href={`/app/agents/${encodeURIComponent(a.name)}`}
                  className="flex items-center gap-2"
                >
                  <span className="mr-auto font-medium">{a.name}</span>
                  {a.demo && (
                    <span className="rounded border border-warn px-1.5 py-0.5 text-xs text-warn">
                      demo
                    </span>
                  )}
                  <span className="rounded bg-line px-1.5 py-0.5 text-xs">{a.runtime}</span>
                  {a.pending > 0 && (
                    <span className="rounded bg-warn px-1.5 py-0.5 text-xs text-white">
                      {a.pending} pending
                    </span>
                  )}
                </Link>
                <p className="text-sm text-muted">
                  {a.funded && a.allowanceLeft
                    ? `${a.allowanceLeft.remaining} of ${a.allowanceLeft.limit} ${a.allowance?.mint ?? ""} left this ${a.allowance?.period.replace(/ly$/, "")}`
                    : "Needs funding"}
                </p>
                {a.runtime === "hosted" && a.funded && (
                  <div className="mt-1.5">
                    <RunNow name={a.name} nextRun={a.nextRun ?? null} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      </Card>

      <div className="space-y-4">
        <Card title="Kill switch">
          <ActionPanel
            path={`/actions/kill-switch?cluster=${app.network}`}
            compact
            danger
            onDone={refresh}
          />
        </Card>
        <TelegramCard />
      </div>

      <div className="md:col-span-3">
        <Card title={`Pending approvals${pendingCount ? ` (${pendingCount})` : ""}`}>
          {!pendingCount && <p className="text-sm text-muted">Nothing waiting for you.</p>}
          <div className="grid gap-4 md:grid-cols-2">
            {data?.pending.drafts.map((d) => (
              <div key={d.id} className="rounded-xl border border-line p-4">
                <ActionPanel path={`/actions/approve-draft/${d.id}`} onDone={refresh} />
              </div>
            ))}
            {data?.pending.topups.map((t) => (
              <div key={t.id} className="rounded-xl border border-line p-4">
                <ActionPanel path={`/actions/approve-topup/${t.id}`} onDone={refresh} />
              </div>
            ))}
          </div>
        </Card>
      </div>

      <div className="md:col-span-3">
        <Card title="Activity">
          <ActivityFeed />
        </Card>
      </div>
    </div>
  );
}

/** Below this an owner cannot pay for the transactions that fund an agent. */
const LOW_SOL = 0.05;

/**
 * Devnet only: test tokens from syndromí's own faucet (one claim a day), and a pointer to the
 * public faucet for devnet SOL, which the owner gets for themselves.
 */
function TestFunds({
  faucet,
  sol,
  onClaimed,
}: {
  faucet: OverviewData["faucet"];
  sol: number;
  onClaimed(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; bad?: boolean }>();
  const next = faucet?.nextAt ? new Date(faucet.nextAt) : undefined;
  const claim = async () => {
    setBusy(true);
    setNote(undefined);
    try {
      const got = await api.faucet();
      setNote({ text: `${got.amount} test ${got.symbol} sent to your wallet.` });
      onClaimed();
    } catch (e) {
      setNote({ text: (e as Error).message, bad: true });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-3 space-y-2 border-t border-line pt-3 text-sm">
      <p className="text-muted">Devnet uses test tokens. They have no value.</p>
      {faucet && (
        <button
          type="button"
          onClick={() => void claim()}
          disabled={busy || Boolean(next)}
          className="rounded-lg bg-accent px-3 py-1.5 font-semibold text-accent-fg disabled:opacity-50"
        >
          {busy ? "Sending…" : `Get ${faucet.amount} test USDC`}
        </button>
      )}
      {next && !note && (
        <p className="text-muted">
          You claimed today. Next claim after{" "}
          {next.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}.
        </p>
      )}
      {note && <p className={note.bad ? "text-bad" : "text-good"}>{note.text}</p>}
      {sol < LOW_SOL && (
        <p>
          You need a little devnet SOL for network fees.{" "}
          <a
            className="text-accent underline"
            href="https://faucet.solana.com"
            target="_blank"
            rel="noreferrer"
          >
            Get devnet SOL
          </a>
        </p>
      )}
    </div>
  );
}
