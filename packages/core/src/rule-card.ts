// The rule card: a manifest's budget and permissions in plain language, for the owner to read
// before signing (dashboard wizard, agent page, Telegram, CLI).
import type { Manifest, Period } from "./manifest.js";
import type { ProgramName } from "./programs.js";

const PERIOD_WORD: Record<Period, string> = { daily: "day", weekly: "week", monthly: "month" };
const PROGRAM_WORD: Record<ProgramName, string> = {
  jupiter: "Jupiter swaps",
  subscriptions: "pulling its allowance",
  token: "token transfers",
  system: "SOL transfers",
};

export const describePeriod = (period: Period) => PERIOD_WORD[period];

const short = (address: string) => `${address.slice(0, 4)}…${address.slice(-4)}`;

const list = (items: string[]) =>
  items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

const usd = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;

export type RuleCardInput = Pick<Manifest, "name" | "allowance" | "permissions" | "fee_budget"> &
  Partial<Pick<Manifest, "runtime">>;

/** One line per rule, in the order an owner cares about. */
export function ruleCard(m: RuleCardInput): string[] {
  const p = m.permissions;
  const destinations = p.destinations.map((d) => (d === "self" ? "its own wallet" : short(d)));
  const lines = [
    `${m.name} may take up to ${m.allowance.amount} ${m.allowance.mint} per ${describePeriod(m.allowance.period)} from your bag. The limit is enforced onchain.`,
    `It may only use ${list(p.programs.map((name) => PROGRAM_WORD[name]))}, and funds may only go to ${list(destinations)}.`,
    `No single transaction may move more than ${usd(p.max_tx_usd)}; anything above ${usd(p.approve_above_usd)} waits for your signature.`,
    `You send it ${m.fee_budget.sol} SOL once for network fees.`,
  ];
  if (m.runtime) {
    lines.push(
      m.runtime === "hosted"
        ? "It runs hosted by syndromi, which holds its key."
        : m.runtime === "external"
          ? "An outside agent (an MCP client such as Claude) decides what to do; its key stays encrypted on your machine, and every action passes these rules."
          : "It runs on your machine, with its key encrypted there.",
    );
  }
  lines.push("You can revoke it at any time with the kill switch.");
  return lines;
}
