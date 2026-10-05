"use client";
// The guided run: the shortest way for a new owner to see what the rules do, with nothing to
// install and no AI to connect. Part one sets up (test funds, a scripted agent, its budget). Part
// two is the run itself, shown live: the agent makes one move at a time, says what it is doing,
// and stops to wait whenever your rules say it must ask. You approve or reject right here, and
// the run carries on or ends accordingly. Devnet only.
import Link from "next/link";
import { type ReactNode, useState } from "react";
import { api, FAUCET_OFF, type Overview, TOUR_TEMPLATE, tourAgentName } from "@/lib/api";
import { explorerTx } from "@/lib/config";
import { type TourMove, type TourMoveKey, tourProgress } from "@/lib/tour";
import { usePoll } from "@/lib/use-poll";
import { ActionPanel } from "./action-panel";
import { RejectButton } from "./reject-button";
import { Card } from "./ui";

/** What the tour agent's allowance needs in the owner's wallet, and SOL enough to fund it. */
const NEED_USDC = 20;
const NEED_SOL = 0.05;
const button = "rounded-lg bg-accent px-3 py-1.5 font-semibold text-accent-fg disabled:opacity-50";

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

  const ready = Boolean(tour?.funded);
  return (
    <Card title="Try a guided run">
      <p className="text-sm text-muted">
        Watch an agent work under your rules before you connect anything. It is scripted (no AI, no
        keys) and uses test tokens, but every decision you see is the real policy.
      </p>

      <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-muted">
        {ready ? "Set up ✓" : "First, set up"}
      </h3>
      {!ready && (
        <ol className="mt-2 space-y-3 text-sm">
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
          <Step
            n={3}
            done={Boolean(tour)}
            title="Create the tour agent"
            locked={!hasSol || !hasUsdc}
          >
            <p className="mb-1.5 text-muted">
              An agent is a wallet of its own plus rules. This one may spend 20 test USDC a week,
              must ask you above $5, and may only send funds to itself.
            </p>
            <button type="button" className={button} disabled={busy} onClick={() => void create()}>
              {busy ? "Creating…" : "Create it"}
            </button>
          </Step>
          <Step n={4} done={ready} title="Give it its budget" locked={!tour}>
            <p className="mb-1.5 text-muted">
              You sign in your wallet. Your funds stay with you: the agent can only pull its
              allowance, and you can revoke it at any time.
            </p>
            {tour && (
              <ActionPanel
                path={`/actions/fund-agent/${encodeURIComponent(tour.name)}`}
                compact
                onDone={onChange}
              />
            )}
          </Step>
        </ol>
      )}
      {error && <p className="mt-3 text-sm text-bad">{error}</p>}

      {tour && ready && (
        <TourRun name={tour.name} paused={Boolean(tour.paused)} onChange={onChange} />
      )}
    </Card>
  );
}

/** What each move is, and what its outcome teaches, in the owner's words. */
const MOVES: Record<
  TourMoveKey,
  { title: string; why: Partial<Record<TourMove["state"], string>> }
> = {
  pull: {
    title: "Pull 10 test USDC from its allowance",
    why: {
      done: "Went through without asking you. An agent may pull its allowance on its own, and the limit is enforced onchain: it cannot take more than you granted.",
    },
  },
  "swap-small": {
    title: "Swap 3 USDC for JitoSOL",
    why: {
      done: "Went through without asking you: $3 is under your $5 approval threshold. Small, routine actions do not interrupt you.",
    },
  },
  "swap-large": {
    title: "Swap 6 USDC for JitoSOL",
    why: {
      waiting:
        "The agent has stopped and is waiting for you. $6 is above your $5 threshold, so it cannot act alone. Approve to let it carry on, or reject to end the run.",
      working: "You approved. The agent is executing it now.",
      done: "You approved, and only then did it execute. Nothing above your threshold moves without your signature.",
      declined: "You said no, so nothing was sent and the agent ended its run.",
    },
  },
  transfer: {
    title: "Send 1 USDC to an address you never approved",
    why: {
      blocked:
        "BLOCKED before anything was signed. You only allowed the agent's own wallet as a destination. This is what protects you if an agent is tricked into sending funds away.",
    },
  },
  topup: {
    title: "Ask you for a 10 USDC top-up",
    why: {
      waiting:
        "The agent is waiting again. It wants more than its budget, and only you can raise that: approving signs a one-time top-up in your wallet.",
      working: "You approved. The agent is pulling its top-up.",
      done: "You approved, and the agent pulled its one-time top-up. Its weekly allowance is unchanged.",
      declined: "You said no. Its budget stays as it was.",
    },
  },
};

const MARK: Record<TourMove["state"], { sign: string; style: string }> = {
  todo: { sign: "", style: "bg-line" },
  working: { sign: "…", style: "bg-line animate-pulse" },
  waiting: { sign: "!", style: "bg-warn text-white" },
  done: { sign: "✓", style: "bg-good text-white" },
  blocked: { sign: "✕", style: "bg-bad text-white" },
  declined: { sign: "–", style: "bg-line" },
  failed: { sign: "✕", style: "bg-bad text-white" },
};

/** The run, live: one row per move, with the owner's decision asked for in place. */
function TourRun({ name, paused, onChange }: { name: string; paused: boolean; onChange(): void }) {
  const { data, refresh } = usePoll(() => api.activity(undefined, name), 1500, [name]);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string>();
  const progress = tourProgress(data?.events ?? []);
  const changed = () => {
    refresh();
    onChange();
  };
  const start = async () => {
    setStarting(true);
    setError(undefined);
    try {
      const { started } = await api.runNow(name);
      if (!started) setError("The server is still loading this agent. Try again in a moment.");
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStarting(false);
    }
  };
  const over = progress.started && !progress.running;

  return (
    <div className="mt-5 text-sm">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
        {over ? "The run" : progress.running ? "The run, live" : "Now run it"}
      </h3>
      {!progress.started && (
        <p className="mt-2 text-muted">
          The agent will make five moves, one at a time. Twice it will stop and wait for you.
        </p>
      )}
      {progress.running && progress.saying && (
        <p className="mt-2 rounded-lg bg-brand-soft px-3 py-2" aria-live="polite">
          <span className="font-semibold">The agent:</span> “{progress.saying}”
        </p>
      )}

      <ol className="mt-3 space-y-3">
        {progress.moves.map((move, i) => {
          const copy = MOVES[move.key];
          const why = copy.why[move.state] ?? (move.state === "failed" ? move.detail : undefined);
          const kind = move.key === "topup" ? "topup" : "draft";
          return (
            <li
              key={move.key}
              className={`flex gap-3 ${move.state === "todo" ? "opacity-50" : ""}`}
            >
              <span
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${MARK[move.state].style}`}
                aria-hidden
              >
                {MARK[move.state].sign || i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-medium">
                  {copy.title}
                  {move.signature && (
                    <a
                      className="ml-2 font-normal text-accent underline"
                      href={explorerTx(move.signature, "devnet")}
                      target="_blank"
                      rel="noreferrer"
                    >
                      view
                    </a>
                  )}
                </p>
                {why && (
                  <p
                    className={
                      move.state === "blocked" || move.state === "failed"
                        ? "text-bad"
                        : "text-muted"
                    }
                  >
                    {why}
                  </p>
                )}
                {move.state === "waiting" && move.requestId && (
                  <div className="mt-2 rounded-xl border border-warn p-3">
                    <ActionPanel
                      path={`/actions/approve-${kind}/${move.requestId}`}
                      compact
                      onDone={changed}
                    />
                    <div className="mt-2">
                      <RejectButton id={move.requestId} onDone={changed} />
                    </div>
                    <p className="mt-2 text-muted">
                      On a real agent this request reaches you wherever you are: under Pending
                      approvals below, and in Telegram if you connect it.
                    </p>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {over && progress.summary && (
        <p className="mt-4 rounded-lg bg-brand-soft px-3 py-2">
          <span className="font-semibold">The agent:</span> “{progress.summary}”
        </p>
      )}
      {paused ? (
        <p className="mt-4 text-warn">This agent is paused. Resume it on its page to run it.</p>
      ) : (
        !progress.running && (
          <button
            type="button"
            className={`mt-4 ${button}`}
            disabled={starting}
            onClick={() => void start()}
          >
            {starting ? "Starting…" : progress.started ? "Run it again" : "Start the run"}
          </button>
        )
      )}
      {error && <p className="mt-2 text-bad">{error}</p>}

      {over && (
        <div className="mt-5 border-t border-line pt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
            Where to go from here
          </h3>
          <ul className="mt-2 space-y-1.5">
            <Next>
              <b>Activity</b>, at the bottom of this page, keeps every step you just saw.
            </Next>
            <Next>
              <Link
                className="text-accent underline"
                href={`/app/agents/${encodeURIComponent(name)}`}
              >
                The agent's page
              </Link>{" "}
              shows its rules and what is left of its budget, and lets you pause it.
            </Next>
            <Next>
              <b>Connect Telegram</b>, on this page, to get approval requests on your phone.
            </Next>
            <Next>
              The <b>kill switch</b> revokes every allowance at once. Try it: this agent goes back
              to “Needs funding”.
            </Next>
            <Next>
              <Link className="font-semibold text-accent underline" href="/app/agents/new">
                Create an agent for your own AI
              </Link>{" "}
              (Claude, Cursor or any MCP client). The same rules apply to whatever it decides.
            </Next>
          </ul>
        </div>
      )}
    </div>
  );
}

const Next = ({ children }: { children: ReactNode }) => (
  <li className="flex gap-2">
    <span className="text-accent">•</span>
    <span>{children}</span>
  </li>
);

/** One numbered setup step: a tick when done, its controls when it is the owner's turn. */
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
