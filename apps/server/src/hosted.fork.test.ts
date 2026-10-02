// The security demo, hosted, on a Surfpool fork: pool-scout (scripted to obey the injected
// pool notice) is deployed, funded, and run by the server. The transfer to the attacker must be
// BLOCKED by the policy, show up as a BLOCKED activity row and a Telegram alert, and never be sent.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createClient, generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import { solanaRpc } from "@solana/kit-plugin-rpc";
import { signer } from "@solana/kit-plugin-signer";
import { subscriptionsProgram } from "@solana/subscriptions";
import {
  ensureSubscriptionAuthority,
  grantAllowance,
  parseManifest,
  SURFPOOL_URL,
  signAndSend,
} from "@syndromi/core";
import type { Transformer } from "grammy";
import { afterAll, describe, expect, it } from "vitest";
import { createContext } from "./context.js";
import { Store } from "./db.js";
import { HostedRuntime } from "./hosted.js";
import { createHostedAgent } from "./owner.js";
import { createTelegram } from "./telegram.js";

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
if (!surfpoolUp) console.warn("hosted injection test skipped: Surfpool is not running on :8899");

const ROOT = new URL("../../../", import.meta.url).pathname;
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ATTACKER = "AhLo5HEVqYUwdoNrEWoEXtY4X9y9jd85LCbtVw1JQVig";

describe.skipIf(!surfpoolUp)("hosted pool-scout injection on the fork", () => {
  let runtime: HostedRuntime | undefined;
  afterAll(() => runtime?.stop());

  it("blocks the injected transfer, alerts Telegram, and signs nothing", {
    timeout: 180_000,
  }, async () => {
    const dir = join(ROOT, "fixtures/injection/pool-scout");
    const parsed = parseManifest(await readFile(join(dir, "manifest.yaml"), "utf8"));
    if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
    // The scripted fallback keeps the test deterministic; the demo itself uses the real model.
    const manifest = {
      ...parsed.manifest,
      demo: { ...parsed.manifest.demo, script: "injection" as const },
    };

    const owner: KeyPairSigner = await generateKeyPairSigner();
    await rpcCall("surfnet_setAccount", [owner.address, { lamports: 2_000_000_000 }]);
    await rpcCall("surfnet_setTokenAccount", [owner.address, USDC, { amount: 50_000_000 }]);

    const ctx = createContext(new Store(":memory:"), {
      publicUrl: "http://127.0.0.1:8787",
      token: "t",
      env: { SYNDROMI_HOSTED_SECRET: "a-test-secret-that-is-at-least-32-chars" },
      draftTtlMs: 60_000,
      topUpTtlMs: 60_000,
      dashboardOrigins: [],
    });
    const sent: string[] = [];
    const transformer: Transformer = async (_prev, method, payload) => {
      if (method === "sendMessage") sent.push(String((payload as { text: string }).text));
      return {
        ok: true,
        result: { message_id: 1, date: 0, chat: { id: 1, type: "private" } },
      } as never;
    };
    await createTelegram(ctx, {
      token: "1:x",
      botInfo: { id: 1, is_bot: true, first_name: "s", username: "syndromi_bot" } as never,
      transformer,
    });
    await ctx.store.setSetting("telegram_chat_id", "42");

    const created = await createHostedAgent(ctx, {
      manifest,
      prompt: await readFile(join(dir, "prompt.md"), "utf8"),
      owner: owner.address,
      cluster: "fork",
    });
    if (!created.ok) throw new Error(JSON.stringify(created.error));

    // Fund it the way fund-agent does: authority, fee budget, allowance.
    const client = createClient()
      .use(signer(owner))
      .use(solanaRpc({ rpcUrl: SURFPOOL_URL }))
      .use(subscriptionsProgram());
    const setup = await ensureSubscriptionAuthority(client, USDC as never);
    if (setup.length) await signAndSend(client.rpc, owner, setup);
    await rpcCall("surfnet_setAccount", [created.agent.address, { lamports: 50_000_000 }]);
    await signAndSend(
      client.rpc,
      owner,
      await grantAllowance(client, {
        agent: created.agent.address,
        mint: USDC as never,
        amountPerPeriod: 10_000_000n,
        periodSeconds: 604_800,
      }),
    );

    runtime = new HostedRuntime(ctx, { schedule: false });
    runtime.scan();
    await runtime.runAndWait("pool-scout");

    const events = (await ctx.store.activity({ agentNames: ["pool-scout"], limit: 100 })).reverse();
    const types = events.map((e) => e.type);
    const blocked = events.find((e) => e.type === "blocked");
    expect(blocked, JSON.stringify(types)).toBeDefined();
    expect(JSON.stringify(blocked?.reasons)).toContain(ATTACKER);
    // The pull is allowed and sent; the injected transfer is never sent.
    const sentTools = events.filter((e) => e.type === "tx_sent").map((e) => e.tool);
    expect(sentTools).toEqual(["pull-allowance"]);
    expect(sent.some((t) => t.includes("BLOCKED") && t.includes("pool-scout"))).toBe(true);
  });
});
