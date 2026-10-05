import {
  type Address,
  appendTransactionMessageInstructions,
  blockhash,
  createNoopSigner,
  createTransactionMessage,
  generateKeyPairSigner,
  type Instruction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { getTransferRecurringInstructionAsync } from "@solana/subscriptions";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  AuthorityType,
  findAssociatedTokenPda,
  getApproveInstruction,
  getCloseAccountInstruction,
  getCreateAssociatedTokenIdempotentInstruction,
  getSetAuthorityInstruction,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { beforeAll, describe, expect, it } from "vitest";
import { createPolicySigner, evaluate, type Intent, type Policy } from "./policy.js";
import { StaticPriceSource } from "./prices.js";
import { JUPITER_PROGRAM_ADDRESS, ORCA_WHIRLPOOL_PROGRAM_ADDRESS } from "./programs.js";
import { findToken } from "./tokens.js";

const usdcToken = findToken("USDC", "mainnet");
const solToken = findToken("SOL", "mainnet");
if (!usdcToken?.mints.devnet || !solToken) throw new Error("registry entries missing");
const USDC = usdcToken.mints.devnet; // devnet USDC, priced as mainnet USDC
const SOL = solToken.mints.mainnet;
const UNPRICED = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" as Address;
const usdc = (n: number) => BigInt(Math.round(n * 1e6));

const prices = new StaticPriceSource({ [usdcToken.mints.mainnet]: 1, [SOL]: 100 });
const basePolicy: Policy = {
  programs: ["jupiter"],
  destinations: ["self"],
  maxTxUsd: 25,
  approveAboveUsd: 10,
};

let agent: Awaited<ReturnType<typeof generateKeyPairSigner>>;
let attacker: Address;
let friend: Address;
let agentAta: Address;
let attackerAta: Address;
let friendAta: Address;

const ata = async (owner: Address, mint: Address = USDC) =>
  (await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];

beforeAll(async () => {
  agent = await generateKeyPairSigner();
  attacker = (await generateKeyPairSigner()).address;
  friend = (await generateKeyPairSigner()).address;
  agentAta = await ata(agent.address);
  attackerAta = await ata(attacker);
  friendAta = await ata(friend);
});

function message(instructions: Instruction[], feePayer: Address = agent.address) {
  return pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: blockhash("11111111111111111111111111111111"), lastValidBlockHeight: 1n },
        m,
      ),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
}

const jupiterSwap = (): Instruction => ({
  programAddress: JUPITER_PROGRAM_ADDRESS,
  accounts: [],
  data: new Uint8Array([1, 2, 3]),
});
const orcaSwap = (): Instruction => ({
  programAddress: ORCA_WHIRLPOOL_PROGRAM_ADDRESS,
  accounts: [],
  data: new Uint8Array([4, 5, 6]),
});
const swapIntent = (usdAmount: number, mint: Address = USDC): Intent => ({
  kind: "swap",
  inputMint: mint,
  inputAmount: usdc(usdAmount),
  outputMint: SOL,
});
const transfer = (destination: Address, amount: number) =>
  getTransferCheckedInstruction({
    source: agentAta,
    mint: USDC,
    destination,
    authority: agent.address,
    amount: usdc(amount),
    decimals: 6,
  });

type Row = {
  name: string;
  build: () => Promise<Instruction[]> | Instruction[];
  intent?: Intent;
  policy?: Partial<Policy>;
  feePayer?: () => Address;
  verdict: "allow" | "needs_approval" | "block";
  reason?: RegExp;
  minReasons?: number;
};

const rows: Row[] = [
  {
    name: "Orca swap that first creates the agent's output token account",
    build: async () => [
      getCreateAssociatedTokenIdempotentInstruction({
        payer: createNoopSigner(agent.address),
        owner: agent.address,
        mint: SOL,
        ata: await ata(agent.address, SOL),
      }),
      orcaSwap(),
    ],
    intent: swapIntent(5),
    policy: { programs: ["orca"] },
    verdict: "allow",
  },
  {
    name: "Orca swap when the owner only allowed Jupiter",
    build: () => [orcaSwap()],
    intent: swapIntent(5),
    verdict: "block",
    reason: /whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc not in allowlist/,
  },
  {
    name: "Orca swap that would open a token account for someone else",
    build: async () => [
      getCreateAssociatedTokenIdempotentInstruction({
        payer: createNoopSigner(agent.address),
        owner: attacker,
        mint: SOL,
        ata: await ata(attacker, SOL),
      }),
      orcaSwap(),
    ],
    intent: swapIntent(5),
    policy: { programs: ["orca"] },
    verdict: "block",
    reason: /token account for .* not in allowlist/,
  },
  {
    name: "Orca swap over the per-tx cap",
    build: () => [orcaSwap()],
    intent: swapIntent(30),
    policy: { programs: ["orca"] },
    verdict: "block",
    reason: /per-tx cap/,
  },
  {
    name: "a token transfer under the orca permission alone",
    build: () => [transfer(agentAta, 1)],
    policy: { programs: ["orca"] },
    verdict: "block",
    reason: /TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA not in allowlist/,
  },
  {
    name: "swap under the approval threshold",
    build: () => [jupiterSwap()],
    intent: swapIntent(5),
    verdict: "allow",
  },
  {
    name: "compute budget + swap",
    build: () => [getSetComputeUnitLimitInstruction({ units: 200_000 }), jupiterSwap()],
    intent: swapIntent(5),
    verdict: "allow",
  },
  {
    name: "swap between threshold and cap",
    build: () => [jupiterSwap()],
    intent: swapIntent(15),
    verdict: "needs_approval",
    reason: /approval threshold/,
  },
  {
    name: "swap over the per-tx cap",
    build: () => [jupiterSwap()],
    intent: swapIntent(30),
    verdict: "block",
    reason: /per-tx cap/,
  },
  {
    name: "swap of a mint with no price",
    build: () => [jupiterSwap()],
    intent: swapIntent(1, UNPRICED),
    verdict: "needs_approval",
    reason: /no USD price/,
  },
  {
    name: "transfer to self",
    build: () => [transfer(agentAta, 5)],
    intent: { kind: "transfer", inputMint: USDC, inputAmount: usdc(5) },
    verdict: "allow",
  },
  {
    name: "INJECTION: transfer to an unknown address",
    build: () => [transfer(attackerAta, 5)],
    intent: { kind: "transfer", inputMint: USDC, inputAmount: usdc(5) },
    verdict: "block",
    reason: /destination .* not in allowlist/,
  },
  {
    name: "INJECTION: transfer hidden inside a 'swap'",
    build: () => [jupiterSwap(), transfer(attackerAta, 1)],
    intent: swapIntent(2),
    verdict: "block",
    reason: /destination .* not in allowlist/,
  },
  {
    name: "transfer to an explicitly allowlisted address",
    build: () => [transfer(friendAta, 5)],
    intent: { kind: "transfer", inputMint: USDC, inputAmount: usdc(5) },
    policy: { destinations: ["self", "FRIEND" as Address] },
    verdict: "allow",
  },
  {
    name: "decoded outflow above declared intent is what counts",
    build: () => [jupiterSwap(), transfer(agentAta, 30)],
    intent: swapIntent(1),
    verdict: "block",
    reason: /per-tx cap/,
  },
  {
    name: "approve a delegate",
    build: () => [
      getApproveInstruction({
        source: agentAta,
        delegate: attacker,
        owner: agent.address,
        amount: usdc(1),
      }),
    ],
    verdict: "block",
    reason: /Approve/,
  },
  {
    name: "set authority",
    build: () => [
      getSetAuthorityInstruction({
        owned: agentAta,
        owner: agent.address,
        authorityType: AuthorityType.AccountOwner,
        newAuthority: attacker,
      }),
    ],
    verdict: "block",
    reason: /SetAuthority/,
  },
  {
    name: "close account to someone else",
    build: () => [
      getCloseAccountInstruction({
        account: agentAta,
        destination: attacker,
        owner: agent.address,
      }),
    ],
    verdict: "block",
    reason: /destination .* not in allowlist/,
  },
  {
    name: "close account back to self",
    build: () => [
      getCloseAccountInstruction({
        account: agentAta,
        destination: agent.address,
        owner: agent.address,
      }),
    ],
    verdict: "allow",
  },
  {
    name: "SOL transfer when the system program is not allowed",
    build: () => [
      getTransferSolInstruction({ source: agent, destination: attacker, amount: 1_000_000n }),
    ],
    verdict: "block",
    reason: /program .* not in allowlist/,
  },
  {
    name: "SOL transfer to an unknown address with the system program allowed",
    build: () => [
      getTransferSolInstruction({ source: agent, destination: attacker, amount: 1_000_000n }),
    ],
    policy: { programs: ["jupiter", "system"] },
    verdict: "block",
    reason: /destination .* not in allowlist/,
  },
  {
    name: "token account created for someone else",
    build: () => [
      getCreateAssociatedTokenIdempotentInstruction({
        payer: agent,
        ata: attackerAta,
        owner: attacker,
        mint: USDC,
      }),
    ],
    verdict: "block",
    reason: /token account for .* not in allowlist/,
  },
  {
    name: "unknown program",
    build: () => [
      {
        programAddress: "BPFLoaderUpgradeab1e11111111111111111111111" as Address,
        accounts: [],
        data: new Uint8Array([0]),
      },
    ],
    verdict: "block",
    reason: /program .* not in allowlist/,
  },
  {
    name: "fee payer is not the agent",
    build: () => [jupiterSwap()],
    intent: swapIntent(1),
    feePayer: () => attacker,
    verdict: "block",
    reason: /fee payer/,
  },
  {
    name: "several violations are all reported",
    build: () => [
      getApproveInstruction({
        source: agentAta,
        delegate: attacker,
        owner: agent.address,
        amount: 1n,
      }),
      transfer(attackerAta, 1),
      {
        programAddress: "BPFLoaderUpgradeab1e11111111111111111111111" as Address,
        accounts: [],
        data: new Uint8Array([0]),
      },
    ],
    verdict: "block",
    minReasons: 3,
  },
  {
    name: "allowance pull into the agent's own account",
    build: async () => [await pull(agentAta)],
    intent: { kind: "pull", inputMint: USDC, inputAmount: usdc(10) },
    policy: { programs: ["subscriptions"] },
    verdict: "allow",
  },
  {
    name: "allowance pull redirected to someone else",
    build: async () => [await pull(attackerAta)],
    intent: { kind: "pull", inputMint: USDC, inputAmount: usdc(10) },
    policy: { programs: ["subscriptions"] },
    verdict: "block",
    reason: /destination .* not in allowlist/,
  },
];

async function pull(receiverAta: Address) {
  const owner = (await generateKeyPairSigner()).address;
  return getTransferRecurringInstructionAsync({
    delegationPda: (await generateKeyPairSigner()).address,
    subscriptionAuthority: (await generateKeyPairSigner()).address,
    delegatorAta: await ata(owner),
    receiverAta,
    tokenMint: USDC,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    delegatee: agent,
    transferData: { amount: usdc(10), delegator: owner, mint: USDC },
  });
}

describe("evaluate()", () => {
  it.each(rows)("$name → $verdict", async (row) => {
    const destinations = (row.policy?.destinations ?? basePolicy.destinations).map((d) =>
      d === ("FRIEND" as Address) ? friend : d,
    );
    const policy = { ...basePolicy, ...row.policy, destinations };
    const decision = await evaluate(
      {
        agent: agent.address,
        tool: "test",
        message: message(await row.build(), row.feePayer?.()),
        intent: row.intent ?? { kind: "other" },
      },
      policy,
      prices,
    );
    expect(decision.verdict, decision.reasons.join("; ")).toBe(row.verdict);
    if (row.reason) expect(decision.reasons.join("\n")).toMatch(row.reason);
    if (row.minReasons) expect(decision.reasons.length).toBeGreaterThanOrEqual(row.minReasons);
  });
});

describe("createPolicySigner()", () => {
  const proposal = (usdAmount: number, instructions?: Instruction[]) => ({
    agent: agent.address,
    tool: "test",
    message: message(instructions ?? [jupiterSwap()]),
    intent: swapIntent(usdAmount),
  });
  const signer = () => createPolicySigner({ signer: agent, policy: basePolicy, prices });

  it("signs an allowed proposal", async () => {
    const result = await signer().sign(proposal(5));
    expect(result.decision.verdict).toBe("allow");
    expect(result.transaction?.signatures[agent.address]).toBeTruthy();
  });

  it("holds needs_approval until an approval is passed", async () => {
    const held = await signer().sign(proposal(15));
    expect(held.decision.verdict).toBe("needs_approval");
    expect(held.transaction).toBeUndefined();
    const approved = await signer().sign(proposal(15), { approvedDraftId: "draft-1" });
    expect(approved.transaction?.signatures[agent.address]).toBeTruthy();
  });

  it("never signs a blocked proposal, even when 'approved'", async () => {
    const result = await signer().sign(proposal(1, [transfer(attackerAta, 1)]), {
      approvedDraftId: "draft-1",
    });
    expect(result.decision.verdict).toBe("block");
    expect(result.transaction).toBeUndefined();
  });

  it("signs only with its own key, ignoring signers that tools embedded", async () => {
    // Program builders need a signer object for the agent; tools pass a noop one.
    const noopAgent = createNoopSigner(agent.address);
    const selfTransfer = getTransferCheckedInstruction({
      source: agentAta,
      mint: USDC,
      destination: agentAta,
      authority: noopAgent,
      amount: usdc(1),
      decimals: 6,
    });
    const result = await signer().sign(proposal(1, [selfTransfer]));
    expect(result.decision.verdict).toBe("allow");
    expect(result.transaction?.signatures[agent.address]).toBeTruthy();

    // A foreign signer embedded by a tool is never used: signing fails rather than co-signing.
    const stranger = await generateKeyPairSigner();
    const withStranger = getTransferCheckedInstruction({
      source: agentAta,
      mint: USDC,
      destination: agentAta,
      authority: stranger,
      amount: usdc(1),
      decimals: 6,
    });
    const policy = { ...basePolicy, programs: ["token" as const] };
    const strict = createPolicySigner({ signer: agent, policy, prices });
    await expect(strict.sign(proposal(1, [withStranger]))).rejects.toThrow();
  });

  it("refuses proposals for a different agent", async () => {
    const other = await generateKeyPairSigner();
    await expect(signer().sign({ ...proposal(1), agent: other.address })).rejects.toThrow(/agent/);
  });
});
