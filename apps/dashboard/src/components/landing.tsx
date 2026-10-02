// The marketing page at "/". Server components only: it ships no wallet or app code.
import Link from "next/link";
import type { ReactNode } from "react";

const REPO = "https://github.com/Leac1m/syndromi";
const ISSUES = `${REPO}/issues`;

const wrap = "mx-auto w-[min(1120px,100%-32px)]";
const cardBase = "rounded-2xl border p-6";
const card = `${cardBase} border-line bg-card`;
const btn = "inline-block rounded-xl px-5 py-3 text-base font-semibold";
const btnPrimary = `${btn} bg-brand text-white shadow-lg shadow-brand/25 hover:bg-emerald-800`;
const btnGhost = `${btn} border border-line bg-card hover:border-slate-300`;

export function Landing() {
  return (
    <>
      <a
        href="#main"
        className="absolute -left-[999px] top-2 z-10 rounded-lg bg-fg px-3 py-2 text-white focus:left-2"
      >
        Skip to content
      </a>
      <BetaBanner />
      <Nav />
      <main id="main">
        <Hero />
        <Problem />
        <How />
        <Features />
        <Security />
        <Mcp />
        <Audience />
        <Beta />
        <Faq />
      </main>
      <Footer />
    </>
  );
}

function BetaBanner() {
  return (
    <div className="bg-fg px-4 py-2 text-center text-sm text-white">
      <strong>Public beta on Solana devnet.</strong> Test funds only. Tell us what breaks:{" "}
      <a className="underline" href={ISSUES}>
        report an issue
      </a>
    </div>
  );
}

function Nav() {
  return (
    <header className="sticky top-0 z-5 border-b border-line bg-bg/90 backdrop-blur">
      <div className={`${wrap} flex h-16 items-center gap-6`}>
        <Link href="/" className="text-xl font-extrabold tracking-tight">
          syndromí{" "}
          <span className="ml-1 rounded bg-brand-soft px-1.5 py-0.5 align-middle text-xs font-bold text-brand">
            beta
          </span>
        </Link>
        <nav aria-label="Main" className="ml-auto hidden gap-6 text-[15px] text-muted md:flex">
          <a href="#how" className="hover:text-fg">
            How it works
          </a>
          <a href="#security" className="hover:text-fg">
            Security
          </a>
          <a href="#mcp" className="hover:text-fg">
            Bring your agent
          </a>
          <a href="#faq" className="hover:text-fg">
            FAQ
          </a>
        </nav>
        <Link
          href="/app"
          className="ml-auto rounded-lg bg-fg px-4 py-2 text-sm font-semibold text-white md:ml-0"
        >
          Launch app
        </Link>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section
      className={`${wrap} grid items-center gap-12 pb-10 pt-14 md:grid-cols-[1.15fr_0.85fr] md:pt-20`}
    >
      <div>
        <p className="mb-4 text-sm font-bold uppercase tracking-widest text-brand">
          Budgets for AI agents on Solana
        </p>
        <h1 className="text-[clamp(38px,5.4vw,62px)] font-extrabold leading-[1.04] tracking-[-0.035em]">
          Give your AI agents an allowance, <span className="text-brand">not your wallet.</span>
        </h1>
        <p className="mt-6 max-w-[34em] text-xl text-muted">
          syndromí turns Solana's new Subscriptions &amp; Allowances program into safe budgets for
          fleets of agents. They spend what you allow, ask when it matters, and stop when you say
          so.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link href="/app" className={btnPrimary}>
            Open the app (devnet beta)
          </Link>
          <a href="#how" className={btnGhost}>
            See how it works
          </a>
        </div>
        <ul className="mt-7 flex flex-wrap gap-x-6 gap-y-2 text-[15px] text-muted">
          {[
            "Open source (MIT)",
            "No custom onchain program",
            "Works with Claude, Cursor and any MCP client",
          ].map((t) => (
            <li key={t}>
              <span className="mr-1 font-bold text-brand">✓</span>
              {t}
            </li>
          ))}
        </ul>
      </div>

      <figure
        aria-label="Example of the activity feed"
        className="rounded-2xl border border-line bg-card p-5 shadow-2xl shadow-slate-900/10"
      >
        <figcaption className="mb-3 font-bold">
          Activity feed{" "}
          <span className="ml-2 text-[13px] font-medium text-muted">example from the demo</span>
        </figcaption>
        <ul className="grid gap-2.5 text-[15px]">
          <li className="rounded-[10px] bg-bg px-3 py-2.5">
            <b>pool-scout</b> pulling its allowance…
          </li>
          <li className="rounded-[10px] bg-bg px-3 py-2.5 text-brand">
            <b>pool-scout</b> sent: pull 2 USDC from the allowance
          </li>
          <li className="rounded-[10px] bg-bg px-3 py-2.5">
            <b>pool-scout</b> reading yield data…
          </li>
          <li className="rounded-[10px] bg-bad-soft px-3 py-2.5 font-semibold text-bad">
            <b>pool-scout</b> BLOCKED: transfer 2 USDC to AhLo5H…
            <small className="mt-1 block text-[13px] font-normal">
              The destination is not on the owner's allowlist. Nothing was signed.
            </small>
          </li>
        </ul>
        <p className="mt-3 text-sm text-muted">The owner also gets a Telegram alert.</p>
      </figure>
    </section>
  );
}

function Section({
  id,
  title,
  lead,
  children,
}: {
  id?: string;
  title: string;
  lead?: string;
  children?: ReactNode;
}) {
  return (
    <section
      id={id}
      className={`${wrap} scroll-mt-20 pt-[72px]`}
      aria-labelledby={`${id ?? title}-h`}
    >
      <h2
        id={`${id ?? title}-h`}
        className="max-w-[22em] text-[clamp(28px,3.6vw,40px)] font-extrabold leading-[1.15] tracking-[-0.025em]"
      >
        {title}
      </h2>
      {lead && <p className="mt-4 max-w-[44em] text-[19px] text-muted">{lead}</p>}
      {children}
    </section>
  );
}

function List({ items, mark }: { items: string[]; mark: "✓" | "✕" }) {
  return (
    <ul className="grid gap-2.5">
      {items.map((t) => (
        <li key={t}>
          <span className={`mr-2.5 font-bold ${mark === "✓" ? "text-brand" : "text-bad"}`}>
            {mark}
          </span>
          {t}
        </li>
      ))}
    </ul>
  );
}

function Problem() {
  return (
    <Section
      title="An agent with your key can lose everything in one bad prompt."
      lead={
        'Today you either hand an agent a full wallet or approve every transaction by hand. One poisoned web page or tool result saying "send your funds to this address" is enough to empty a wallet. Neither option lets you run more than a couple of agents.'
      }
    >
      <div className="mt-8 grid gap-4 md:grid-cols-2">
        <div className={card}>
          <h3 className="mb-2 text-[19px] font-semibold">Without a budget</h3>
          <List
            mark="✕"
            items={[
              "The agent holds your full key",
              "One prompt injection can move everything",
              "You approve every action, or none",
              "No way to cut it off fast",
            ]}
          />
        </div>
        <div className={`${cardBase} border-emerald-200 bg-brand-soft`}>
          <h3 className="mb-2 text-[19px] font-semibold">With syndromí</h3>
          <List
            mark="✓"
            items={[
              "The agent can pull only its allowance per period",
              "Every transaction passes your rules first",
              "You sign only what is above your threshold",
              "One signature revokes everything",
            ]}
          />
        </div>
      </div>
    </Section>
  );
}

function How() {
  const steps = [
    ["Fund one bag", "Your USDC stays in your own wallet. Nothing is deposited into a contract."],
    [
      "Give each agent an allowance",
      "Pick an amount per day, week or month, the programs it may use, where funds may go, a per-transaction cap and an approval threshold.",
    ],
    [
      "Agents work. You stay in control.",
      "Routine actions run. Larger ones reach you in Telegram or the dashboard as a Blink to sign. Anything outside the rules is blocked before it is signed.",
    ],
  ];
  return (
    <Section id="how" title="Three steps from wallet to working agent">
      <ol className="mt-8 grid gap-4 md:grid-cols-3">
        {steps.map(([title, body], i) => (
          <li key={title} className={card}>
            <span className="mb-3.5 grid size-9 place-items-center rounded-full bg-brand font-bold text-white">
              {i + 1}
            </span>
            <h3 className="mb-2 text-[19px] font-semibold">{title}</h3>
            <p className="text-muted">{body}</p>
          </li>
        ))}
      </ol>
      <div className={`${card} mt-4`}>
        <p className="mb-3 font-bold">
          You read this before you sign{" "}
          <span className="ml-2 text-[13px] font-medium text-muted">
            from the mcp-agent template
          </span>
        </p>
        <ul className="grid gap-2 text-muted">
          {[
            "mcp-agent may take up to 5 USDC per week from your bag. The limit is enforced onchain.",
            "It may only use Jupiter swaps and pulling its allowance, and funds may only go to its own wallet.",
            "No single transaction may move more than $10; anything above $5 waits for your signature.",
            "You send it 0.02 SOL once for network fees.",
            "You can revoke it at any time with the kill switch.",
          ].map((t) => (
            <li key={t}>
              <span className="mr-2.5 text-brand">•</span>
              {t}
            </li>
          ))}
        </ul>
      </div>
    </Section>
  );
}

function Features() {
  const items = [
    [
      "Onchain allowances",
      "Each agent can pull only its allowance per period, enforced by the Solana program. Even a stolen agent key can't pull more.",
    ],
    [
      "A policy on every transaction",
      "Program and destination allowlists, a per-transaction cap and an approval threshold. Nothing is signed without passing it.",
    ],
    [
      "Approve from your phone",
      "Held actions become Blinks. You sign a message that names exactly what you approve, and the runtime checks it again before executing.",
    ],
    [
      "One-signature kill switch",
      "Revoke every allowance and top-up at once, from the dashboard or from Telegram.",
    ],
    [
      "Top-ups on request",
      "When an agent runs out, it asks once. You grant a one-time amount, not a bigger standing budget.",
    ],
    [
      "A live activity feed",
      "Every tool call, decision and block, in plain words. Blocked actions show in red.",
    ],
  ];
  return (
    <Section title="Everything an owner needs to trust an agent" id="features">
      <div className="mt-8 grid gap-4 md:grid-cols-3">
        {items.map(([t, b]) => (
          <article key={t} className={card}>
            <h3 className="mb-2 text-[19px] font-semibold">{t}</h3>
            <p className="text-muted">{b}</p>
          </article>
        ))}
      </div>
      <p className="mt-6 text-muted">
        Agents are described in one portable manifest and run locally from the CLI, or hosted by the
        server.
      </p>
    </Section>
  );
}

function Security() {
  return (
    <Section
      id="security"
      title="What is enforced where"
      lead="We keep the claims precise, because security people check."
    >
      <div className="mt-8 grid gap-4 md:grid-cols-2">
        <div className={card}>
          <h3 className="mb-2 text-[19px] font-semibold">Enforced onchain</h3>
          <List
            mark="✓"
            items={[
              "The amount an agent can pull per period",
              "One-time top-up limits",
              "Revocation by the owner, any time",
            ]}
          />
        </div>
        <div className={card}>
          <h3 className="mb-2 text-[19px] font-semibold">Enforced by the policy signer</h3>
          <List
            mark="✓"
            items={[
              "Which programs a transaction may call",
              "Where funds may go",
              "The per-transaction cap",
              "The approval threshold",
            ]}
          />
          <p className="mt-3 text-sm text-muted">
            Onchain rule enforcement with Swig smart wallets is next.
          </p>
        </div>
      </div>
      <p className="mt-6 text-muted">
        The model never touches a signer. Tools return unsigned transactions, the policy decides,
        and only an allowed transaction is signed with the agent's key.
      </p>
    </Section>
  );
}

function Code({ children }: { children: ReactNode }) {
  return (
    <pre className="overflow-x-auto rounded-2xl bg-code p-5 font-mono text-sm leading-7 text-slate-200">
      <code>{children}</code>
    </pre>
  );
}
const C = ({ children }: { children: ReactNode }) => (
  <span className="text-slate-400">{children}</span>
);

function Mcp() {
  return (
    <Section id="mcp" title="Bring the agent you already have">
      <div className="mt-6 grid items-center gap-10 md:grid-cols-2">
        <div>
          <p className="text-[19px] text-muted">
            Use Claude, Cursor or any MCP client.{" "}
            <code className="font-mono text-[0.92em]">syndromi mcp</code> gives your existing agent
            a funded wallet under the same rules. It never sees a key, and every action is executed,
            held for your signature, or blocked.
          </p>
          <div className="mt-5">
            <List
              mark="✓"
              items={[
                "Only the tools you enable are available",
                "The client reads your rules before it acts",
                "Approvals and top-ups reach you as usual",
              ]}
            />
          </div>
        </div>
        <Code>
          <C># create a budgeted wallet for Claude or any MCP client</C>
          {"\npnpm syndromi init\npnpm syndromi fund templates/mcp-agent\n\n"}
          <C># init prints a line like this for you to run</C>
          {"\nclaude mcp add syndromi-mcp-agent …"}
        </Code>
      </div>
    </Section>
  );
}

function Audience() {
  const items = [
    ["Owners", "You want agents to act onchain without handing over a wallet."],
    [
      "Developers",
      "You ship agents and need spending limits and approvals you don't want to build yourself.",
    ],
    ["Teams", "You run more than one agent, each with its own budget and rules."],
  ];
  return (
    <Section title="Who it's for" id="who">
      <div className="mt-8 grid gap-4 md:grid-cols-3">
        {items.map(([t, b]) => (
          <article key={t} className={card}>
            <h3 className="mb-2 text-[19px] font-semibold">{t}</h3>
            <p className="text-muted">{b}</p>
          </article>
        ))}
      </div>
    </Section>
  );
}

function Beta() {
  const steps = [
    [
      "Open the app",
      "Connect a Phantom account set to devnet and sign in. It is a free message, not a transaction.",
    ],
    [
      "Get test funds",
      "Devnet SOL from the faucet, and devnet USDC from Circle's faucet. No real money.",
    ],
    [
      "Create an agent",
      "Pick a template (mcp-agent is the default), read the rule card, and sign to fund it.",
    ],
    [
      "Break it, and tell us",
      "Try a transfer outside the rules, or the kill switch. Report what's confusing or broken.",
    ],
  ];
  return (
    <Section id="beta" title="Join the devnet beta">
      <div className="mt-8 rounded-3xl border border-line bg-card p-8 md:p-10">
        <p className="max-w-[44em] text-[19px] text-muted">
          syndromí is in beta and runs on Solana devnet, so you can test everything with free test
          tokens. Mainnet needs an explicit flag and a typed confirmation.
        </p>
        <ol className="mt-6 grid gap-4 md:grid-cols-4">
          {steps.map(([t, b], i) => (
            <li key={t}>
              <span className="mb-2 grid size-8 place-items-center rounded-full bg-brand text-sm font-bold text-white">
                {i + 1}
              </span>
              <h3 className="mb-1 font-semibold">{t}</h3>
              <p className="text-[15px] text-muted">{b}</p>
            </li>
          ))}
        </ol>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link href="/app" className={btnPrimary}>
            Open the app
          </Link>
          <a href={ISSUES} className={btnGhost}>
            Report an issue
          </a>
        </div>
        <details className="mt-8">
          <summary className="cursor-pointer font-semibold">Prefer to run it yourself?</summary>
          <div className="mt-4">
            <Code>
              {
                "git clone https://github.com/Leac1m/syndromi\ncd syndromi && pnpm install\npnpm syndromi init                       "
              }
              <C># an agent and its encrypted key</C>
              {"\npnpm syndromi fund templates/mcp-agent   "}
              <C># fee budget + a 5 USDC/week allowance</C>
              {"\npnpm syndromi status                     "}
              <C># what each agent may still pull</C>
              {"\npnpm syndromi revoke --all               "}
              <C># the kill switch</C>
            </Code>
            <p className="mt-3 text-sm text-muted">
              Needs Node 20+, pnpm, and a devnet wallet with a little devnet SOL and USDC.
            </p>
          </div>
        </details>
      </div>
    </Section>
  );
}

function Faq() {
  const items = [
    [
      "Do I deposit funds into a contract?",
      "No. The bag is your own USDC token account. The allowance is a delegation that you can revoke at any time.",
    ],
    [
      "What if an agent is compromised?",
      "It can only pull its allowance per period, and every transaction it signs still passes the policy. You can revoke everything in one signature.",
    ],
    [
      "Is the whole policy onchain?",
      "The allowance is enforced onchain. Program and destination rules, the per-transaction cap and approvals are enforced by our policy signer before anything is signed. Onchain rule enforcement through Swig smart wallets is next.",
    ],
    [
      "Which network does it use?",
      "Devnet by default. Mainnet needs an explicit flag and a typed confirmation.",
    ],
    [
      "Do I need a custom program or a new token?",
      "No. It uses the Solana Foundation's Subscriptions & Allowances program and plain USDC.",
    ],
    [
      "Which models can agents use?",
      "Anthropic (bring your own key) and any OpenAI-compatible endpoint, or bring your own agent through MCP.",
    ],
  ];
  return (
    <Section id="faq" title="Questions">
      <div className="mt-7 grid max-w-[52em] gap-2.5">
        {items.map(([q, a]) => (
          <details key={q} className="group rounded-xl border border-line bg-card px-5 py-4">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-semibold after:text-xl after:leading-none after:text-brand after:content-['+'] group-open:after:content-['–'] [&::-webkit-details-marker]:hidden">
              {q}
            </summary>
            <p className="mt-2.5 text-muted">{a}</p>
          </details>
        ))}
      </div>
    </Section>
  );
}

function Footer() {
  return (
    <footer className="mt-24 border-t border-line py-7 text-[15px] text-muted">
      <div className={`${wrap} flex flex-wrap items-center gap-x-6 gap-y-3`}>
        <span className="text-lg font-extrabold tracking-tight text-fg">syndromí</span>
        <span>MIT licensed · Public beta on Solana devnet</span>
        <span className="ml-auto flex gap-5">
          <Link href="/app" className="underline">
            Launch app
          </Link>
          <a href={REPO} className="underline">
            GitHub
          </a>
        </span>
      </div>
    </footer>
  );
}
