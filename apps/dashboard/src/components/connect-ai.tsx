"use client";
import { useState } from "react";
import { api, TOKEN_DAYS, type TokenView } from "@/lib/api";
import { type Client, snippet } from "@/lib/snippets";
import { usePoll } from "@/lib/use-poll";
import { Card } from "./ui";

const CLIENTS: { id: Client; label: string }[] = [
  { id: "claude", label: "Claude Code" },
  { id: "cursor", label: "Cursor" },
  { id: "http", label: "curl" },
  { id: "functions", label: "Your own code" },
];

function status(t: TokenView): { label: string; live: boolean } {
  if (t.revokedAt) return { label: "revoked", live: false };
  if (Date.parse(t.expiresAt) <= Date.now()) return { label: "expired", live: false };
  return { label: "active", live: true };
}

/**
 * Connect an AI: tokens for a server-held agent, and snippets for Claude Code, Cursor, curl and
 * your own code. A token is shown once, at creation; it reaches only this agent, and everything it
 * does still passes the agent's rules and your approvals.
 */
export function ConnectAi({ agent }: { agent: string }) {
  const { data, error, refresh } = usePoll(() => api.tokens(agent), 10_000, [agent]);
  const [days, setDays] = useState<number>(30);
  const [label, setLabel] = useState("");
  const [fresh, setFresh] = useState<{ token: string; prefix: string }>();
  const [client, setClient] = useState<Client>("claude");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [copied, setCopied] = useState(false);

  async function create() {
    setBusy(true);
    setFailure(undefined);
    try {
      const made = await api.createToken(agent, days, label.trim());
      setFresh({ token: made.token, prefix: made.prefix });
      setLabel("");
      refresh();
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setFailure(undefined);
    try {
      await api.revokeToken(agent, id);
      refresh();
    } catch (e) {
      setFailure((e as Error).message);
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable: the text is selectable
    }
  }

  const text = snippet(client, agent, fresh?.token ?? "<YOUR_TOKEN>");
  const button =
    "rounded-lg border border-line px-3 py-1.5 text-sm font-medium disabled:opacity-50";
  return (
    <Card title="Connect an AI">
      <div className="space-y-4 text-sm">
        <p className="text-muted">
          Give Claude, Cursor or your own code a token and it can use this agent, inside the rules
          above. Anything over your approval limit comes to you to sign, and the kill switch revokes
          every token. This agent's key stays on the server (devnet only).
        </p>

        <div className="flex flex-wrap items-end gap-2">
          <label className="grid gap-1">
            <span className="text-muted">Label (optional)</span>
            <input
              value={label}
              maxLength={40}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="my laptop"
              className="rounded-lg border border-line bg-card px-3 py-1.5"
            />
          </label>
          <label className="grid gap-1">
            <span className="text-muted">Expires after</span>
            <select
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              className="rounded-lg border border-line bg-card px-3 py-1.5"
            >
              {TOKEN_DAYS.map((d) => (
                <option key={d} value={d}>
                  {d === 1 ? "1 day" : `${d} days`}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={busy}
            onClick={() => void create()}
            className="rounded-lg bg-accent px-3 py-1.5 font-semibold text-accent-fg disabled:opacity-50"
          >
            Create token
          </button>
        </div>

        {fresh && (
          <div className="rounded-xl border border-warn p-3">
            <p className="font-medium">Copy your token now. It is shown only once.</p>
            <code className="mt-2 block break-all rounded-lg bg-line p-2 text-xs">
              {fresh.token}
            </code>
            <div className="mt-2 flex gap-2">
              <button type="button" className={button} onClick={() => void copy(fresh.token)}>
                {copied ? "Copied" : "Copy token"}
              </button>
              <button type="button" className={button} onClick={() => setFresh(undefined)}>
                I saved it
              </button>
            </div>
          </div>
        )}

        <div>
          <div className="mb-2 flex flex-wrap gap-1">
            {CLIENTS.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setClient(c.id)}
                className={`rounded-lg border px-3 py-1 ${client === c.id ? "border-accent font-semibold" : "border-line text-muted"}`}
              >
                {c.label}
              </button>
            ))}
          </div>
          <pre className="overflow-x-auto rounded-lg bg-line p-3 text-xs">{text}</pre>
          {!fresh && (
            <p className="mt-1 text-muted">
              Replace &lt;YOUR_TOKEN&gt; with a token. Treat it like a password: anyone holding it
              can use this agent within its rules.
            </p>
          )}
        </div>

        <div>
          <h3 className="mb-1 font-semibold">Tokens</h3>
          {!data?.tokens.length && <p className="text-muted">No tokens yet.</p>}
          <ul className="divide-y divide-line">
            {data?.tokens.map((t) => {
              const s = status(t);
              return (
                <li key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                  <code className="text-xs">{t.prefix}…</code>
                  <span className="mr-auto">{t.label || "unnamed"}</span>
                  <span className="text-muted">
                    {t.lastUsedAt
                      ? `used ${new Date(t.lastUsedAt).toLocaleString()}`
                      : "never used"}
                    {" · "}
                    {s.live ? `expires ${new Date(t.expiresAt).toLocaleDateString()}` : s.label}
                  </span>
                  {s.live && (
                    <button
                      type="button"
                      onClick={() => void revoke(t.id)}
                      className="rounded-lg border border-line px-2 py-1 text-xs hover:text-bad"
                    >
                      Revoke
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
        {(failure || error) && <p className="text-bad">{failure ?? error}</p>}
      </div>
    </Card>
  );
}
