"use client";
import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { short } from "@/lib/config";
import { useApp } from "./providers";

export function Shell({ children }: { children: ReactNode }) {
  const app = useApp();
  return (
    <div className="mx-auto max-w-5xl px-4 pb-16">
      <header className="flex flex-wrap items-center gap-3 py-5">
        <Link href="/app" className="mr-auto flex items-center gap-2 text-xl font-bold tracking-tight">
          <Image src="/icon.png" alt="syndromí logo" width={28} height={32} className="h-7 w-auto" />
          syndromí
        </Link>
        <div className="flex overflow-hidden rounded-lg border border-line text-sm">
          {(["devnet", "fork", "mainnet"] as const).map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => app.setNetwork(n)}
              className={`px-3 py-1.5 ${app.network === n ? (n === "mainnet" ? "bg-bad text-white" : "bg-accent text-accent-fg") : "text-muted"}`}
            >
              {n}
            </button>
          ))}
        </div>
        {app.signedIn && app.owner ? (
          <button
            type="button"
            onClick={() => void app.signOut()}
            className="rounded-lg border border-line px-3 py-1.5 text-sm"
          >
            {short(app.owner)} · sign out
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void app.connect()}
            disabled={app.connecting}
            className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-accent-fg disabled:opacity-50"
          >
            {app.connecting ? "Connecting…" : "Connect Phantom"}
          </button>
        )}
      </header>
      {app.network === "fork" && (
        <div className="mb-4 rounded-lg border border-warn px-4 py-2 text-sm text-warn">
          Fork: a local Surfpool copy of mainnet for rehearsals. Phantom only signs (its preview may
          warn about mainnet fees); syndromi sends to the fork.
        </div>
      )}
      {app.network === "mainnet" && (
        <div className="mb-4 rounded-lg bg-bad px-4 py-2 text-sm font-medium text-white">
          Mainnet: real funds. Every signature asks you to type “mainnet” first.
        </div>
      )}
      {app.error && (
        <div className="mb-4 rounded-lg border border-bad px-4 py-2 text-sm text-bad">
          {app.error}
        </div>
      )}
      {app.signedIn ? children : <Welcome />}
    </div>
  );
}

function Welcome() {
  return (
    <section className="mt-16 text-center">
      <h1 className="text-3xl font-bold">Budgets for your AI agents</h1>
      <p className="mx-auto mt-3 max-w-xl text-muted">
        Give each agent an allowance your bag enforces onchain, rules it cannot break, and approvals
        you sign. Connect the Phantom account that owns your bag, then sign in (a free message, no
        transaction).
      </p>
    </section>
  );
}
