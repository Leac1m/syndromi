"use client";
import { useState } from "react";
import { api } from "@/lib/api";
import { usePoll } from "@/lib/use-poll";
import { Card } from "./ui";

/**
 * Connect Telegram: the server issues a one-time link for the signed-in wallet; opening it and
 * pressing Start binds that chat. The card polls, so it flips to "connected" by itself. A link
 * only routes alerts: approving always means signing in the wallet.
 */
export function TelegramCard() {
  const { data, error, refresh } = usePoll(() => api.telegram(), 4000, []);
  const [link, setLink] = useState<{ url: string; expiresAt: string }>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();

  async function connect() {
    setBusy(true);
    setFailure(undefined);
    try {
      setLink(await api.telegramLink());
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setFailure(undefined);
    try {
      await api.telegramDisconnect();
      setLink(undefined);
      refresh();
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const connected = (data?.chats ?? 0) > 0;
  const button =
    "rounded-lg border border-line px-3 py-1.5 text-sm font-medium disabled:opacity-50";
  return (
    <Card title="Telegram">
      {!data && !error && <p className="text-sm text-muted">…</p>}
      {data && !data.enabled && (
        <p className="text-sm text-muted">This server has no Telegram bot set up.</p>
      )}
      {data?.enabled && (
        <div className="space-y-2 text-sm">
          <p className={connected ? "text-good" : "text-muted"}>
            {connected
              ? `Connected (${data.chats} chat${data.chats === 1 ? "" : "s"}). Approvals and BLOCKED alerts for your agents arrive there.`
              : "Get approval requests and BLOCKED alerts on your phone."}
          </p>
          {link && (
            <p>
              <a
                href={link.url}
                target="_blank"
                rel="noreferrer"
                className="inline-block rounded-lg bg-accent px-3 py-1.5 font-semibold text-accent-fg"
              >
                Open Telegram
              </a>{" "}
              <span className="text-muted">
                and press Start. The link works once, for 10 minutes.
              </span>
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" className={button} disabled={busy} onClick={() => void connect()}>
              {connected ? "Add another chat" : link ? "New link" : "Connect Telegram"}
            </button>
            {connected && (
              <button
                type="button"
                className={`${button} hover:text-bad`}
                disabled={busy}
                onClick={() => void disconnect()}
              >
                Disconnect
              </button>
            )}
          </div>
        </div>
      )}
      {(failure || error) && <p className="mt-2 text-sm text-bad">{failure ?? error}</p>}
    </Card>
  );
}
