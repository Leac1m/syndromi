// End to end on a Surfpool mainnet fork with a scripted model: the owner grants an allowance,
// then one run pulls 3 USDC and swaps it for SOL through Jupiter, via the policy signer.
// Skipped when Surfpool is not running on :8899.
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, generateKeyPairSigner } from "@solana/kit";
import { solanaRpc } from "@solana/kit-plugin-rpc";
import { signer } from "@solana/kit-plugin-signer";
import { subscriptionsProgram } from "@solana/subscriptions";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import {
  ensureSubscriptionAuthority,
  findToken,
  grantAllowance,
  parseManifest,
  StaticPriceSource,
  SURFPOOL_URL,
  sendAndConfirm,
  signAndSend,
} from "@syndromi/core";
import { createToolset } from "@syndromi/tools";
import { describe, expect, it } from "vitest";
import { ActivityLog, memorySink } from "./activity.js";
import { prepareAgent } from "./agent.js";
import { LocalApprovalGateway } from "./approvals.js";
import { call, finish, ScriptedProvider, useTools } from "./llm/scripted.js";
import { runOnce } from "./loop.js";

const rpcCall = (method: string, params: unknown[] = []) =>
  fetch(SURFPOOL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  }).then((r) => r.json());
const surfpoolUp = await rpcCall("getHealth")
  .then(() => true)
  .catch(() => false);
if (!surfpoolUp) console.warn("runtime fork test skipped: Surfpool is not running on :8899");

const root = new URL("../../../", import.meta.url).pathname;
const USDC = findToken("USDC", "mainnet")?.mints.mainnet;
const SOL = findToken("SOL", "mainnet")?.mints.mainnet;

describe.skipIf(!surfpoolUp)("dca run on a Surfpool fork", () => {
  it("pulls its allowance and executes a Jupiter swap", { timeout: 180_000 }, async () => {
    if (!USDC || !SOL) throw new Error("registry");
    const parsed = parseManifest(
      await readFile(join(root, "templates/dca-agent/manifest.yaml"), "utf8"),
    );
    if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
    const manifest = parsed.manifest;

    const ownerSigner = await generateKeyPairSigner();
    const agentSigner = await generateKeyPairSigner();
    await rpcCall("surfnet_setAccount", [ownerSigner.address, { lamports: 2_000_000_000 }]);
    await rpcCall("surfnet_setAccount", [agentSigner.address, { lamports: 100_000_000 }]);
    await rpcCall("surfnet_setTokenAccount", [ownerSigner.address, USDC, { amount: 100_000_000 }]);

    const owner = createClient()
      .use(signer(ownerSigner))
      .use(solanaRpc({ rpcUrl: SURFPOOL_URL }))
      .use(subscriptionsProgram());
    const setup = await ensureSubscriptionAuthority(owner, USDC);
    if (setup.length) await signAndSend(owner.rpc, owner.payer, setup);
    await signAndSend(
      owner.rpc,
      owner.payer,
      await grantAllowance(owner, {
        agent: agentSigner.address,
        mint: USDC,
        amountPerPeriod: 20_000_000n,
        periodSeconds: 604_800,
      }),
    );

    const prices = new StaticPriceSource({ [USDC]: 1, [SOL]: 120 });
    const agent = prepareAgent({
      manifest,
      cluster: "fork",
      agentSigner,
      owner: ownerSigner.address,
      env: {},
      prices,
    });
    const sink = memorySink();
    const before = await agent.rpc.getBalance(agentSigner.address).send();
    const summary = await runOnce({
      manifest,
      prompt: "Pull 3 USDC and buy SOL with it.",
      provider: new ScriptedProvider([
        useTools(call("pull-allowance", { amount: 3 })),
        useTools(call("jupiter-swap", { from: "USDC", to: "SOL", amount: 3 })),
        finish("Pulled 3 USDC and bought SOL."),
      ]),
      tools: createToolset(manifest.tools),
      signer: agent.signer,
      ctx: agent.ctx,
      log: new ActivityLog(manifest.name, [sink]),
      approvals: new LocalApprovalGateway(await mkdtemp(join(tmpdir(), "syndromi-fork-"))),
      send: (tx) => sendAndConfirm(agent.rpc, tx),
    });

    const errors = sink.events.filter((e) => e.type === "error");
    expect(errors).toEqual([]);
    expect(summary.sent).toHaveLength(2);
    const [ata] = await findAssociatedTokenPda({
      owner: agentSigner.address,
      mint: USDC,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const usdc = await agent.rpc.getTokenAccountBalance(ata).send();
    expect(usdc.value.amount).toBe("0"); // pulled 3, swapped 3
    const after = await agent.rpc.getBalance(agentSigner.address).send();
    expect(after.value).toBeGreaterThan(before.value); // SOL bought, net of fees and rent
  });
});
