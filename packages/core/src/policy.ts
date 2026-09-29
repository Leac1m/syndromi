// The policy signer: nothing an agent does is signed without passing through here.
//
// Tools (never the LLM) build an unsigned transaction plus an `intent` describing the value it
// moves. `evaluate` decides allow | needs_approval | block; `createPolicySigner` signs only what
// is allowed, or what needs approval once an owner-approved draft id is supplied.

import {
  type Address,
  type Instruction,
  type KeyPairSigner,
  type ReadonlyUint8Array,
  setTransactionMessageFeePayerSigner,
  signTransactionMessageWithSigners,
  type TransactionMessage,
  type TransactionMessageWithBlockhashLifetime,
  type TransactionMessageWithFeePayer,
} from "@solana/kit";
import {
  parseSubscriptionsInstruction,
  SUBSCRIPTIONS_PROGRAM_ADDRESS,
  SubscriptionsInstruction,
} from "@solana/subscriptions";
import {
  parseSystemInstruction,
  SYSTEM_PROGRAM_ADDRESS,
  SystemInstruction,
} from "@solana-program/system";
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  AssociatedTokenInstruction,
  findAssociatedTokenPda,
  parseAssociatedTokenInstruction,
  parseTokenInstruction,
  TOKEN_PROGRAM_ADDRESS,
  TokenInstruction,
} from "@solana-program/token";
import type { PriceSource } from "./prices.js";
import { allowedPrograms, type ProgramName } from "./programs.js";
import { TOKENS, tokenByMint, toUiAmount } from "./tokens.js";

export type Verdict = "allow" | "needs_approval" | "block";

/** What the transaction is for, as described by tool code (never by the model). */
export type Intent = {
  kind: "swap" | "transfer" | "pull" | "other";
  inputMint?: Address;
  inputAmount?: bigint;
  outputMint?: Address;
};

export type ProposalMessage = TransactionMessage &
  TransactionMessageWithFeePayer &
  TransactionMessageWithBlockhashLifetime;

export type Proposal = {
  agent: Address;
  tool: string;
  message: ProposalMessage;
  intent: Intent;
};

export type Policy = {
  programs: readonly ProgramName[];
  /** "self" means the agent's own wallet; anything else is an explicit owner address. */
  destinations: readonly ("self" | Address)[];
  maxTxUsd: number;
  approveAboveUsd: number;
};

export type Decision = { verdict: Verdict; reasons: string[]; usd?: number };

type Outflow = { mint?: Address; amount: bigint; lamports?: boolean };

export async function evaluate(
  proposal: Proposal,
  policy: Policy,
  prices: PriceSource,
): Promise<Decision> {
  const { agent, message, intent } = proposal;
  const blocks: string[] = [];
  const owners = new Set<Address>(policy.destinations.map((d) => (d === "self" ? agent : d)));
  const programs = allowedPrograms(policy.programs);
  const outflows: Outflow[] = [];

  // 1. The agent pays for (and so signs) its own transactions.
  if (message.feePayer.address !== agent) {
    blocks.push(`fee payer ${message.feePayer.address} is not the agent ${agent}`);
  }

  // 2 + 3. Program allowlist, then decode anything that can move funds.
  const isAllowedAccount = await allowedTokenAccounts(owners, intent);
  for (const [i, ix] of message.instructions.entries()) {
    const at = `instruction #${i}`;
    if (!programs.has(ix.programAddress)) {
      blocks.push(`${at}: program ${ix.programAddress} not in allowlist`);
      continue;
    }
    const withData = ix as Instruction & { data: ReadonlyUint8Array };
    try {
      if (ix.programAddress === TOKEN_PROGRAM_ADDRESS) {
        checkToken(withData, at, owners, isAllowedAccount, blocks, outflows);
      } else if (ix.programAddress === SYSTEM_PROGRAM_ADDRESS) {
        checkSystem(withData, at, owners, blocks, outflows);
      } else if (ix.programAddress === ASSOCIATED_TOKEN_PROGRAM_ADDRESS) {
        checkAssociatedToken(withData, at, owners, blocks);
      } else if (ix.programAddress === SUBSCRIPTIONS_PROGRAM_ADDRESS) {
        await checkSubscriptions(withData, at, owners, blocks);
      }
    } catch (error) {
      blocks.push(`${at}: could not decode ${ix.programAddress} instruction (${String(error)})`);
    }
  }

  // 4. USD value: the larger of what the tool declared and what we decoded. Pulls bring funds
  //    in (and are capped onchain by the delegation), so they are not counted as outflows.
  const declared =
    intent.kind !== "pull" && intent.inputMint && intent.inputAmount !== undefined
      ? [{ mint: intent.inputMint, amount: intent.inputAmount }]
      : [];
  const valued = await Promise.all([...declared, ...outflows].map((o) => usdValue(o, prices)));
  const unpriced = valued.some((v) => v === undefined);
  const declaredUsd = declared.length ? (valued[0] ?? 0) : 0;
  const decodedUsd = valued.slice(declared.length).reduce<number>((s, v) => s + (v ?? 0), 0);
  const usd = Math.max(declaredUsd, decodedUsd);

  if (blocks.length) return { verdict: "block", reasons: blocks, usd };
  if (usd > policy.maxTxUsd) {
    return {
      verdict: "block",
      reasons: [`$${usd.toFixed(2)} exceeds the per-tx cap of $${policy.maxTxUsd}`],
      usd,
    };
  }
  if (unpriced) {
    return {
      verdict: "needs_approval",
      reasons: ["no USD price for an asset in this transaction; owner must approve"],
      usd,
    };
  }
  if (usd > policy.approveAboveUsd) {
    return {
      verdict: "needs_approval",
      reasons: [`$${usd.toFixed(2)} is above the approval threshold of $${policy.approveAboveUsd}`],
      usd,
    };
  }
  return { verdict: "allow", reasons: [], usd };
}

function checkToken(
  ix: Instruction & { data: ReadonlyUint8Array },
  at: string,
  owners: Set<Address>,
  isAllowedAccount: (account: Address, mint?: Address) => boolean,
  blocks: string[],
  outflows: Outflow[],
) {
  const parsed = parseTokenInstruction(ix);
  switch (parsed.instructionType) {
    case TokenInstruction.TransferChecked: {
      const { destination, mint } = parsed.accounts;
      if (!isAllowedAccount(destination.address, mint.address)) {
        blocks.push(`${at}: token destination ${destination.address} not in allowlist`);
      }
      outflows.push({ mint: mint.address, amount: parsed.data.amount });
      return;
    }
    case TokenInstruction.Transfer: {
      const { destination } = parsed.accounts;
      if (!isAllowedAccount(destination.address)) {
        blocks.push(`${at}: token destination ${destination.address} not in allowlist`);
      }
      outflows.push({ amount: parsed.data.amount }); // no mint → unpriced → needs approval
      return;
    }
    case TokenInstruction.CloseAccount: {
      const { destination } = parsed.accounts;
      if (!owners.has(destination.address)) {
        blocks.push(`${at}: close destination ${destination.address} not in allowlist`);
      }
      return;
    }
    case TokenInstruction.SyncNative:
      return;
    default:
      blocks.push(
        `${at}: token instruction ${TokenInstruction[parsed.instructionType]} not allowed`,
      );
  }
}

function checkSystem(
  ix: Instruction & { data: ReadonlyUint8Array },
  at: string,
  owners: Set<Address>,
  blocks: string[],
  outflows: Outflow[],
) {
  const parsed = parseSystemInstruction(ix);
  if (parsed.instructionType !== SystemInstruction.TransferSol) {
    blocks.push(
      `${at}: system instruction ${SystemInstruction[parsed.instructionType]} not allowed`,
    );
    return;
  }
  const { destination } = parsed.accounts;
  if (!owners.has(destination.address)) {
    blocks.push(`${at}: SOL destination ${destination.address} not in allowlist`);
  }
  outflows.push({ lamports: true, amount: parsed.data.amount });
}

function checkAssociatedToken(
  ix: Instruction & { data: ReadonlyUint8Array },
  at: string,
  owners: Set<Address>,
  blocks: string[],
) {
  const parsed = parseAssociatedTokenInstruction(ix);
  if (parsed.instructionType === AssociatedTokenInstruction.RecoverNestedAssociatedToken) {
    blocks.push(`${at}: RecoverNestedAssociatedToken not allowed`);
    return;
  }
  const { owner } = parsed.accounts;
  if (!owners.has(owner.address)) {
    blocks.push(`${at}: token account for ${owner.address} not in allowlist`);
  }
}

async function checkSubscriptions(
  ix: Instruction & { data: ReadonlyUint8Array },
  at: string,
  owners: Set<Address>,
  blocks: string[],
) {
  const parsed = parseSubscriptionsInstruction(ix);
  if (
    parsed.instructionType !== SubscriptionsInstruction.TransferRecurring &&
    parsed.instructionType !== SubscriptionsInstruction.TransferFixed
  ) {
    blocks.push(
      `${at}: agents may only pull; ${SubscriptionsInstruction[parsed.instructionType]} not allowed`,
    );
    return;
  }
  const { receiverAta, tokenMint } = parsed.accounts;
  for (const owner of owners) {
    const [expected] = await findAssociatedTokenPda({
      owner,
      mint: tokenMint.address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    if (expected === receiverAta.address) return;
  }
  blocks.push(`${at}: pull destination ${receiverAta.address} not in allowlist`);
}

/**
 * Allowed token accounts: the associated token accounts of allowed owners, for every mint we know
 * about (registry + the intent's mints). Precomputed so the per-instruction check is synchronous.
 */
async function allowedTokenAccounts(owners: Set<Address>, intent: Intent) {
  const mints = new Set<Address>(
    TOKENS.flatMap((t) => [t.mints.mainnet, ...(t.mints.devnet ? [t.mints.devnet] : [])]),
  );
  if (intent.inputMint) mints.add(intent.inputMint);
  if (intent.outputMint) mints.add(intent.outputMint);
  const byMint = new Map<Address, Set<Address>>();
  for (const mint of mints) {
    const accounts = new Set<Address>();
    for (const owner of owners) {
      const [ata] = await findAssociatedTokenPda({
        owner,
        mint,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
      accounts.add(ata);
    }
    byMint.set(mint, accounts);
  }
  return (account: Address, mint?: Address) => {
    if (mint) return byMint.get(mint)?.has(account) ?? false;
    return [...byMint.values()].some((accounts) => accounts.has(account));
  };
}

async function usdValue(o: Outflow, prices: PriceSource): Promise<number | undefined> {
  if (o.amount === 0n) return 0;
  if (o.lamports) {
    const sol = TOKENS.find((t) => t.symbol === "SOL");
    const price = sol ? await prices.usdPrice(sol.mints.mainnet) : undefined;
    return price === undefined ? undefined : toUiAmount(o.amount, 9) * price;
  }
  if (!o.mint) return undefined;
  const token = tokenByMint(o.mint);
  const price = await prices.usdPrice(o.mint);
  if (!token || price === undefined) return undefined;
  return toUiAmount(o.amount, token.decimals) * price;
}

export type SignResult = {
  decision: Decision;
  transaction?: Awaited<ReturnType<typeof signTransactionMessageWithSigners>>;
};

/**
 * Wraps an agent's keypair so it can only sign what the policy allows. The runtime holds this,
 * never the raw signer.
 */
export function createPolicySigner(opts: {
  signer: KeyPairSigner;
  policy: Policy;
  prices: PriceSource;
}) {
  return {
    address: opts.signer.address,
    policy: opts.policy,
    async sign(
      proposal: Proposal,
      approval: { approvedDraftId?: string } = {},
    ): Promise<SignResult> {
      if (proposal.agent !== opts.signer.address) {
        throw new Error(
          `proposal is for agent ${proposal.agent}, signer is ${opts.signer.address}`,
        );
      }
      const decision = await evaluate(proposal, opts.policy, opts.prices);
      const approved = decision.verdict === "needs_approval" && Boolean(approval.approvedDraftId);
      if (decision.verdict !== "allow" && !approved) return { decision };
      const message = setTransactionMessageFeePayerSigner(
        opts.signer,
        withoutEmbeddedSigners(proposal.message),
      );
      return { decision, transaction: await signTransactionMessageWithSigners(message) };
    },
  };
}

export type PolicySigner = ReturnType<typeof createPolicySigner>;

/**
 * Drops signer objects that tools embedded in account metas (e.g. a noop signer for the agent,
 * which program builders require). Only the policy signer's own key ever signs; a transaction
 * that needs any other signature fails to sign instead of being signed by a tool's signer.
 */
export function withoutEmbeddedSigners<M extends ProposalMessage>(message: M): M {
  const instructions = message.instructions.map((ix) =>
    ix.accounts
      ? Object.freeze({
          ...ix,
          accounts: ix.accounts.map((meta) => {
            if (!("signer" in meta)) return meta;
            const { signer: _signer, ...rest } = meta as typeof meta & { signer: unknown };
            return Object.freeze(rest);
          }),
        })
      : ix,
  );
  return Object.freeze({ ...message, instructions }) as unknown as M;
}
