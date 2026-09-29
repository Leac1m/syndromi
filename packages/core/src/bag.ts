// The bag: the owner's token account, and the delegations that let agents pull from it.
// Recurring delegation = an agent's allowance; fixed delegation = an approved top-up;
// revoke = the kill switch. Every write returns plain instructions so the CLI can send them
// directly and the dashboard can hand them to the owner's wallet.
import type {
  Address,
  GetAccountInfoApi,
  GetMultipleAccountsApi,
  GetProgramAccountsApi,
  Instruction,
  Rpc,
  TransactionSigner,
} from "@solana/kit";
import {
  type Delegation,
  fetchDelegationsByDelegator,
  fetchMaybeSubscriptionAuthority,
  findFixedDelegationPda,
  findRecurringDelegationPda,
  findSubscriptionAuthorityPda,
  type RecurringDelegation,
  type SubscriptionsPluginInstructions,
} from "@solana/subscriptions";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";

export type BagRpc = Rpc<GetAccountInfoApi & GetMultipleAccountsApi & GetProgramAccountsApi>;

/** A kit client with a signer, RPC, and `.use(subscriptionsProgram())`. */
export type BagClient = {
  payer: TransactionSigner;
  rpc: BagRpc;
  subscriptions: { instructions: SubscriptionsPluginInstructions };
};

/** Nonce 0 is the agent's allowance; top-ups use 1, 2, ... */
const ALLOWANCE_NONCE = 0n;

const nowSeconds = () => BigInt(Math.floor(Date.now() / 1000));

const ata = async (owner: Address, mint: Address) =>
  (await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];

// ---------------------------------------------------------------- owner side

/**
 * Instructions to create the (owner, mint) Subscription Authority, or [] if it exists. It must
 * land before any grant: the SDK reads the authority's init id while building a delegation.
 * Needed once per owner and mint.
 */
export async function ensureSubscriptionAuthority(
  client: BagClient,
  mint: Address,
): Promise<Instruction[]> {
  const [authority] = await findSubscriptionAuthorityPda({
    user: client.payer.address,
    tokenMint: mint,
  });
  const existing = await fetchMaybeSubscriptionAuthority(client.rpc, authority);
  if (existing.exists) return [];
  return [
    await client.subscriptions.instructions.initSubscriptionAuthority({
      owner: client.payer,
      tokenMint: mint,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      userAta: await ata(client.payer.address, mint),
    }),
  ];
}

async function requireSubscriptionAuthority(client: BagClient, mint: Address) {
  if ((await ensureSubscriptionAuthority(client, mint)).length > 0) {
    throw new Error(
      `no Subscription Authority for ${client.payer.address} and mint ${mint}: send ensureSubscriptionAuthority() first`,
    );
  }
}

/** Grant an agent its recurring allowance (amount per period, in base units). */
export async function grantAllowance(
  client: BagClient,
  args: {
    agent: Address;
    mint: Address;
    amountPerPeriod: bigint;
    periodSeconds: number;
    /** Hard stop; defaults to one year. */
    expiresInSeconds?: number;
  },
): Promise<Instruction[]> {
  await requireSubscriptionAuthority(client, args.mint);
  return [
    await client.subscriptions.instructions.createRecurringDelegation({
      delegator: client.payer,
      tokenMint: args.mint,
      delegatee: args.agent,
      nonce: ALLOWANCE_NONCE,
      amountPerPeriod: args.amountPerPeriod,
      periodLengthS: BigInt(args.periodSeconds),
      startTs: 0n, // start when it lands
      expiryTs: nowSeconds() + BigInt(args.expiresInSeconds ?? 365 * 86_400),
    }),
  ];
}

/** Approve a one-time top-up. Uses the next free nonce for this agent. */
export async function grantTopUp(
  client: BagClient,
  args: { agent: Address; mint: Address; amount: bigint; expiresInSeconds?: number },
): Promise<{ instructions: Instruction[]; nonce: bigint }> {
  await requireSubscriptionAuthority(client, args.mint);
  // Delegation accounts don't store their nonce, so find the first unused PDA from 1 upward.
  const taken = new Set(
    (await fetchDelegationsByDelegator(client.rpc, client.payer.address)).map((d) => d.address),
  );
  const [authority] = await findSubscriptionAuthorityPda({
    user: client.payer.address,
    tokenMint: args.mint,
  });
  let nonce = 1n;
  for (; ; nonce++) {
    const [pda] = await findFixedDelegationPda({
      subscriptionAuthority: authority,
      delegator: client.payer.address,
      delegatee: args.agent,
      nonce,
    });
    if (!taken.has(pda)) break;
  }
  const instructions = [
    await client.subscriptions.instructions.createFixedDelegation({
      delegator: client.payer,
      tokenMint: args.mint,
      delegatee: args.agent,
      nonce,
      amount: args.amount,
      expiryTs: nowSeconds() + BigInt(args.expiresInSeconds ?? 7 * 86_400),
    }),
  ];
  return { instructions, nonce };
}

export async function revoke(client: BagClient, delegation: Address): Promise<Instruction[]> {
  return [
    client.subscriptions.instructions.revokeDelegation({
      authority: client.payer,
      delegationAccount: delegation,
    }),
  ];
}

/**
 * Kill switch: revoke every delegation the owner has made (optionally for one agent). With
 * `hard`, also clear the token-account approval for each mint so nothing can be pulled at all.
 */
export async function revokeAll(
  client: BagClient,
  opts: { agent?: Address; hard?: boolean } = {},
): Promise<Instruction[]> {
  const delegations = (await fetchDelegationsByDelegator(client.rpc, client.payer.address)).filter(
    (d): d is Exclude<Delegation, { kind: "subscription" }> =>
      d.kind !== "subscription" && (!opts.agent || d.data.header.delegatee === opts.agent),
  );
  const instructions: Instruction[] = delegations.map((d) =>
    client.subscriptions.instructions.revokeDelegation({
      authority: client.payer,
      delegationAccount: d.address,
    }),
  );
  if (opts.hard) {
    const mints = new Set(delegations.map((d) => d.data.mint));
    for (const mint of mints) {
      instructions.push(
        await client.subscriptions.instructions.revokeSubscriptionAuthority({
          user: client.payer,
          tokenMint: mint,
          tokenProgram: TOKEN_PROGRAM_ADDRESS,
        }),
      );
    }
  }
  return instructions;
}

// ---------------------------------------------------------------- agent side

type PullArgs = { owner: Address; mint: Address; amount: bigint };

/** Pull from the allowance into the agent's own token account (created if missing). */
export async function pullAllowance(agent: BagClient, args: PullArgs): Promise<Instruction[]> {
  const [authority] = await findSubscriptionAuthorityPda({
    user: args.owner,
    tokenMint: args.mint,
  });
  const [delegation] = await findRecurringDelegationPda({
    subscriptionAuthority: authority,
    delegator: args.owner,
    delegatee: agent.payer.address,
    nonce: ALLOWANCE_NONCE,
  });
  return pull(agent, "recurring", delegation, args);
}

/** Pull from an approved top-up (a fixed delegation). */
export async function pullTopUp(
  agent: BagClient,
  args: PullArgs & { delegation: Address },
): Promise<Instruction[]> {
  return pull(agent, "fixed", args.delegation, args);
}

async function pull(
  agent: BagClient,
  kind: "recurring" | "fixed",
  delegationPda: Address,
  args: PullArgs,
): Promise<Instruction[]> {
  const input = {
    delegatee: agent.payer,
    delegator: args.owner,
    delegatorAta: await ata(args.owner, args.mint),
    tokenMint: args.mint,
    delegationPda,
    amount: args.amount,
    receiverAta: await ata(agent.payer.address, args.mint),
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  };
  return [
    await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer: agent.payer,
      owner: agent.payer.address,
      mint: args.mint,
    }),
    kind === "recurring"
      ? await agent.subscriptions.instructions.transferRecurring(input)
      : await agent.subscriptions.instructions.transferFixed(input),
  ];
}

// ---------------------------------------------------------------- reads

export type DelegationView = {
  address: Address;
  kind: "allowance" | "top-up";
  agent: Address;
  mint: Address;
  /** Allowance: amount per period. Top-up: amount left. */
  limit: bigint;
  /** What the agent can still pull right now. */
  remaining: bigint;
  /** Allowance only: when the current period ends (unix seconds). */
  periodEndsAt?: bigint;
  expiresAt: bigint;
};

/** The owner's delegations, with what each agent can still pull at `now` (unix seconds). */
export async function listDelegations(
  rpc: BagRpc,
  owner: Address,
  now: bigint = nowSeconds(),
): Promise<DelegationView[]> {
  const delegations = await fetchDelegationsByDelegator(rpc, owner);
  return delegations.flatMap((d): DelegationView[] => toView(d, now));
}

function toView(d: Delegation, now: bigint): DelegationView[] {
  if (d.kind === "subscription") return [];
  const base = {
    address: d.address,
    agent: d.data.header.delegatee,
    mint: d.data.mint,
  };
  if (d.kind === "recurring") {
    const { remaining, periodEndsAt } = recurringRemaining(d.data, now);
    return [
      {
        ...base,
        kind: "allowance",
        limit: d.data.amountPerPeriod,
        remaining,
        periodEndsAt,
        expiresAt: d.data.expiryTs,
      },
    ];
  }
  {
    const expired = d.data.expiryTs !== 0n && now >= d.data.expiryTs;
    return [
      {
        ...base,
        kind: "top-up",
        limit: d.data.amount,
        remaining: expired ? 0n : d.data.amount,
        expiresAt: d.data.expiryTs,
      },
    ];
  }
}

/** Remaining allowance at `now`, rolling the period forward the way the program does. */
export function recurringRemaining(
  d: Pick<
    RecurringDelegation,
    | "currentPeriodStartTs"
    | "periodLengthS"
    | "expiryTs"
    | "amountPerPeriod"
    | "amountPulledInPeriod"
  >,
  now: bigint,
): { remaining: bigint; periodEndsAt: bigint } {
  const start = d.currentPeriodStartTs;
  const length = d.periodLengthS;
  if (d.expiryTs !== 0n && now >= d.expiryTs) return { remaining: 0n, periodEndsAt: d.expiryTs };
  if (now < start) return { remaining: 0n, periodEndsAt: start + length };
  const elapsedPeriods = (now - start) / length;
  const periodEndsAt = start + (elapsedPeriods + 1n) * length;
  if (elapsedPeriods > 0n) return { remaining: d.amountPerPeriod, periodEndsAt };
  const left = d.amountPerPeriod - d.amountPulledInPeriod;
  return { remaining: left > 0n ? left : 0n, periodEndsAt };
}
