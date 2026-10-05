"use client";
// The dashboard is useless until the server answers, and the server restarts on every deploy.
// Until the first answer the page waits here; after that, a lost connection only shows a notice,
// so what the owner was looking at stays on screen.
import { type ReactNode, useEffect, useState } from "react";
import { pingServer } from "@/lib/api";

export type ServerStatus = "connecting" | "up" | "reconnecting";

const RETRY_MS = 3_000;
const CHECK_MS = 20_000;

/** Pings /healthz: quickly until the server answers, then now and then to notice it going away. */
export function useServerStatus() {
  const [status, setStatus] = useState<ServerStatus>("connecting");
  const [waitedS, setWaitedS] = useState(0);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    let seen = false;
    const started = Date.now();
    const tick = async () => {
      const ok = await pingServer();
      if (!alive) return;
      if (ok) seen = true;
      setStatus(ok ? "up" : seen ? "reconnecting" : "connecting");
      setWaitedS(Math.round((Date.now() - started) / 1000));
      timer = setTimeout(() => void tick(), ok ? CHECK_MS : RETRY_MS);
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);
  return { status, waitedS };
}

export function ServerGate({
  status,
  waitedS,
  children,
}: {
  status: ServerStatus;
  waitedS: number;
  children: ReactNode;
}) {
  if (status === "connecting") {
    return (
      <section className="mt-16 text-center" aria-live="polite">
        <div
          className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-line border-t-accent"
          aria-hidden
        />
        <h1 className="mt-4 text-xl font-bold">Connecting to the server…</h1>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted">
          {waitedS < 10
            ? "This usually takes a moment."
            : "The server is starting up. This can take up to a minute after an update; the page continues on its own."}
        </p>
      </section>
    );
  }
  return (
    <>
      {status === "reconnecting" && (
        <div
          className="mb-4 rounded-lg border border-warn px-4 py-2 text-sm text-warn"
          aria-live="polite"
        >
          Lost the connection to the server. Reconnecting… what you see may be out of date.
        </div>
      )}
      {children}
    </>
  );
}
