// End to end on devnet with a scripted model and syndromí's own test tokens: the treasury (as the
// owner) grants an allowance, then one run pulls it, swaps on the Orca test pool, and meets each
// policy outcome: executed, held for approval, blocked, and a top-up request.
//
// It sends real devnet transactions and needs the beta treasury, so it only runs when asked:
//   SYNDROMI_DEVNET_E2E=1 pnpm test packages/runtime/src/devnet.test.ts
// with SYNDROMI_TREASURY_KEY set, or ~/.syndromi/treasury.json present (pnpm beta:setup).
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, createKeyPairSignerFromBytes, generateKeyPairSigner } from "@solana/kit";
import { solanaRpc } from "@solana/kit-plugin-rpc";
import { signer } from "@solana/kit-plugin-signer";
import { subscriptionsProgram } from "@solana/subscriptions";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getMintToCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import {
  ensureSubscriptionAuthority,
  findToken,
  grantAllowance,
  listDelegations,
  parseManifest,
  revoke,
  rpcUrlFor,
  StaticPriceSource,
  secretKeyBytes,
  sendAndConfirm,
  signAndSend,
  syndromiHome,
} from "@syndromi/core";
import { createToolset } from "@syndromi/tools";
import { describe, expect, it } from "vitest";
import { ActivityLog, memorySink } from "./activity.js";
import { prepareAgent } from "./agent.js";
import { LocalApprovalGateway } from "./approvals.js";
import { call, finish, ScriptedProvider, useTools } from "./llm/scripted.js";
import { runOnce } from "./loop.js";

const treasuryKey =
  process.env.SYNDROMI_DEVNET_E2E === "1"
    ? (process.env.SYNDROMI_TREASURY_KEY ??
      (await readFile(join(syndromiHome(process.env.SYNDROMI_HOME), "treasury.json"), "utf8").catch(
        () => undefined,
      )))
    : undefined;

const usdcToken = findToken("USDC", "devnet");
const jitoToken = findToken("JitoSOL", "devnet");
const STRANGER = "AhLo5HEVqYUwdoNrEWoEXtY4X9y9jd85LCbtVw1JQVig"; // fixtures/injection

const MANIFEST = `
name: devnet-e2e
runtime: external
allowance: { mint: USDC, amount: 20, period: weekly }
fee_budget: { sol: 0.02 }
permissions:
  programs: [orca, token, subscriptions]
  destinations: [self]
  max_tx_usd: 10
  approve_above_usd: 5
tools: [balances, orca-quote, orca-swap, pull-allowance, request-topup, propose-tx]
`;

describe.skipIf(!treasuryKey)("a run on devnet with the test tokens and the Orca test pool", () => {
  it("pulls, swaps, is held, is blocked, and asks for a top-up", { timeout: 300_000 }, async () => {
    const USDC = usdcToken?.mints.devnet;
    const JITO = jitoToken?.mints.devnet;
    if (!USDC || !JITO || !usdcToken || !jitoToken || !treasuryKey) throw new Error("registry");
    const parsed = parseManifest(MANIFEST);
    if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
    const manifest = parsed.manifest;

    const rpcUrl = rpcUrlFor("devnet");
    const treasury = await createKeyPairSignerFromBytes(secretKeyBytes(treasuryKey, "treasury"));
    const agentSigner = await generateKeyPairSigner();
    const owner = createClient()
      .use(signer(treasury))
      .use(solanaRpc({ rpcUrl }))
      .use(subscriptionsProgram());
    const ata = async (who: typeof treasury.address, mint: typeof USDC) =>
      (await findAssociatedTokenPda({ owner: who, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];

    // The owner side: SOL for the agent's fees, 20 test USDC in the owner's wallet, an allowance.
    await signAndSend(owner.rpc, treasury, [
      getTransferSolInstruction({
        source: treasury,
        destination: agentSigner.address,
        amount: 20_000_000n,
      }),
      await getCreateAssociatedTokenIdempotentInstructionAsync({
        payer: treasury,
        owner: treasury.address,
        mint: USDC,
      }),
      getMintToCheckedInstruction({
        mint: USDC,
        token: await ata(treasury.address, USDC),
        mintAuthority: treasury,
        amount: 20_000_000n,
        decimals: 6,
      }),
    ]);
    const setup = await ensureSubscriptionAuthority(owner, USDC);
    if (setup.length) await signAndSend(owner.rpc, treasury, setup);
    await signAndSend(
      owner.rpc,
      treasury,
      await grantAllowance(owner, {
        agent: agentSigner.address,
        mint: USDC,
        amountPerPeriod: 20_000_000n,
        periodSeconds: 604_800,
      }),
    );

    try {
      const prices = new StaticPriceSource({
        [usdcToken.mints.mainnet]: 1,
        [jitoToken.mints.mainnet]: 160,
      });
      const agent = prepareAgent({
        manifest,
        cluster: "devnet",
        agentSigner,
        owner: treasury.address,
        env: process.env,
        prices,
      });
      const sink = memorySink();
      const summary = await runOnce({
        manifest,
        prompt: "Walk through each policy outcome.",
        provider: new ScriptedProvider([
          useTools(call("pull-allowance", { amount: 10 })),
          useTools(call("orca-quote", { from: "USDC", to: "JitoSOL", amount: 3 })),
          useTools(call("orca-swap", { from: "USDC", to: "JitoSOL", amount: 3 })),
          useTools(call("orca-swap", { from: "USDC", to: "JitoSOL", amount: 6 })),
          useTools(call("propose-tx", { token: "USDC", to: STRANGER, amount: 1 })),
          useTools(call("request-topup", { amount: 5, reason: "the weekly allowance is used up" })),
          finish("Done."),
        ]),
        tools: createToolset(manifest.tools),
        signer: agent.signer,
        ctx: agent.ctx,
        log: new ActivityLog(manifest.name, [sink]),
        approvals: new LocalApprovalGateway(await mkdtemp(join(tmpdir(), "syndromi-devnet-"))),
        send: (tx) => sendAndConfirm(agent.rpc, tx),
      });

      expect(sink.events.filter((e) => e.type === "error")).toEqual([]);
      expect(summary.sent).toHaveLength(2); // the pull and the 3 USDC swap
      expect(summary.drafts).toHaveLength(1); // 6 USDC is above the $5 threshold
      expect(summary.blocked).toBe(1); // a stranger is not an allowed destination
      expect(summary.topUps).toHaveLength(1);

      const usdc = await agent.rpc
        .getTokenAccountBalance(await ata(agentSigner.address, USDC))
        .send();
      expect(usdc.value.amount).toBe("7000000"); // pulled 10, swapped 3
      const jito = await agent.rpc
        .getTokenAccountBalance(await ata(agentSigner.address, JITO))
        .send();
      expect(BigInt(jito.value.amount)).toBeGreaterThan(0n);
    } finally {
      // Leave no allowance behind on the treasury.
      const mine = (await listDelegations(owner.rpc, treasury.address)).filter(
        (d) => d.agent === agentSigner.address,
      );
      for (const d of mine) await signAndSend(owner.rpc, treasury, await revoke(owner, d.address));
    }
  });
});
