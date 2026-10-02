"use client";
import Link from "next/link";
import { use } from "react";
import { ActionPanel } from "@/components/action-panel";
import { ActivityFeed } from "@/components/activity-feed";
import { ConnectAi } from "@/components/connect-ai";
import { useApp } from "@/components/providers";
import { RemoveAgent } from "@/components/remove-agent";
import { RunNow } from "@/components/run-now";
import { Card, RuleCard } from "@/components/ui";
import { api } from "@/lib/api";
import { short } from "@/lib/config";
import { usePoll } from "@/lib/use-poll";

export default function AgentPage({ params }: { params: Promise<{ name: string }> }) {
  const { name: raw } = use(params);
  const name = decodeURIComponent(raw);
  const app = useApp();
  const { data, refresh } = usePoll(() => api.overview(app.network), 5000, [app.network]);
  const agent = data?.agents.find((a) => a.name === name);

  if (data && !agent) {
    return (
      <p className="text-sm text-muted">
        No agent “{name}” on {app.network}.{" "}
        <Link href="/app" className="underline">
          Back
        </Link>
      </p>
    );
  }
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card
        title={name}
        action={
          <span className="text-sm text-muted">
            {agent ? `${agent.runtime} · ${short(agent.address)}` : ""}
          </span>
        }
      >
        {agent?.demo && (
          <p className="mb-3 rounded-lg border border-warn px-3 py-2 text-sm text-warn">
            Demo agent: it is deliberately fed a prompt injection to show the policy blocking it.
          </p>
        )}
        {agent && <RuleCard lines={agent.ruleCard} />}
        {agent?.runtime === "hosted" && agent.funded && (
          <div className="mt-4">
            <RunNow name={agent.name} nextRun={agent.nextRun ?? null} />
          </div>
        )}
        {agent && !agent.funded && agent.pending === 0 && (
          <div className="mt-4">
            <RemoveAgent name={agent.name} />
          </div>
        )}
      </Card>
      <Card title={agent?.funded ? "Allowance" : "Fund this agent"}>
        {agent?.funded && agent.allowanceLeft ? (
          <div className="space-y-2 text-sm">
            <p className="text-2xl font-bold tabular-nums">
              {agent.allowanceLeft.remaining} / {agent.allowanceLeft.limit} {agent.allowance?.mint}
            </p>
            {agent.allowanceLeft.periodEndsAt && (
              <p className="text-muted">
                Resets {new Date(agent.allowanceLeft.periodEndsAt).toLocaleString()}
              </p>
            )}
            {agent.topUps.map((t) => (
              <p key={t.expiresAt}>
                Top-up: {t.remaining} left until {new Date(t.expiresAt).toLocaleDateString()}
              </p>
            ))}
          </div>
        ) : agent ? (
          <ActionPanel
            path={`/actions/fund-agent/${encodeURIComponent(name)}`}
            compact
            onDone={refresh}
          />
        ) : (
          <p className="text-sm text-muted">Loading…</p>
        )}
      </Card>
      {agent?.custody === "server" && (
        <div className="md:col-span-2">
          <ConnectAi agent={agent.name} />
        </div>
      )}
      <div className="md:col-span-2">
        <Card title="Activity">
          <ActivityFeed agent={name} />
        </Card>
      </div>
    </div>
  );
}
