"use client";
import Link from "next/link";
import { ActionPanel } from "@/components/action-panel";
import { ActivityFeed } from "@/components/activity-feed";
import { useApp } from "@/components/providers";
import { Card } from "@/components/ui";
import { api } from "@/lib/api";
import { usePoll } from "@/lib/use-poll";

export default function Overview() {
  const app = useApp();
  const { data, error, refresh } = usePoll(() => api.overview(app.network), 5000, [
    app.network,
    app.owner,
  ]);

  const allocated = Object.entries(data?.allocatedPerPeriod ?? {})
    .map(([period, amount]) => `${amount} USDC ${period}`)
    .join(" + ");
  const pendingCount = (data?.pending.drafts.length ?? 0) + (data?.pending.topups.length ?? 0);

  return (
    <div className="grid gap-4 md:grid-cols-3">
      {error && <p className="text-sm text-bad md:col-span-3">Server: {error}</p>}

      <Card title="Bag">
        <p className="text-3xl font-bold tabular-nums">
          {data ? data.bag.usdc.toLocaleString() : "…"}{" "}
          <span className="text-base font-medium text-muted">USDC</span>
        </p>
        <p className="mt-1 text-sm text-muted">
          {data ? `${data.bag.sol.toFixed(4)} SOL for fees` : ""}
        </p>
        <p className="mt-3 text-sm">Allocated: {allocated || "nothing yet"}</p>
        {app.network === "devnet" && (
          <a
            className="mt-2 inline-block text-sm text-accent underline"
            href="https://faucet.circle.com"
            target="_blank"
            rel="noreferrer"
          >
            Get devnet USDC
          </a>
        )}
      </Card>

      <Card
        title="Agents"
        action={
          <Link
            href="/agents/new"
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
                  href={`/agents/${encodeURIComponent(a.name)}`}
                  className="flex items-center gap-2"
                >
                  <span className="mr-auto font-medium">{a.name}</span>
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
              </li>
            ))}
          </ul>
        </div>
      </Card>

      <Card title="Kill switch">
        <ActionPanel
          path={`/actions/kill-switch?cluster=${app.network}`}
          compact
          danger
          onDone={refresh}
        />
      </Card>

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
