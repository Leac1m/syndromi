"use client";
import { type ActivityEvent, api } from "@/lib/api";
import { explorerTx } from "@/lib/config";
import { feedLine } from "@/lib/format";
import { useActivity } from "@/lib/use-poll";
import { useApp } from "./providers";
import { tone } from "./ui";

export function ActivityFeed({ agent }: { agent?: string }) {
  const app = useApp();
  const events = useActivity(
    (after) => api.activity(after, agent),
    3000,
    `${app.owner}:${agent ?? ""}`,
  );
  const lines = events
    .map((e) => feedLine(e as ActivityEvent))
    .filter((l): l is NonNullable<typeof l> => Boolean(l))
    .reverse();
  if (!lines.length) return <p className="text-sm text-muted">No activity yet.</p>;
  return (
    <ol className="max-h-[28rem] space-y-2 overflow-y-auto text-sm">
      {lines.map((l) => (
        <li key={l.key} className="flex gap-3">
          <time className="shrink-0 tabular-nums text-muted">{l.at.slice(11, 19)}</time>
          <span className={`min-w-0 break-words ${tone[l.tone]}`}>
            <span className="font-medium">{l.agent}</span> {l.text}
            {l.signature && (
              <a
                className="ml-2 underline"
                href={explorerTx(l.signature, app.network)}
                target="_blank"
                rel="noreferrer"
              >
                view
              </a>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}
