// Phase-4 done-when, automated on a Surfpool fork: a yield-scout draft goes to the approvals
// server, the owner approves it through the real Actions endpoints (sign-message), and the
// watcher executes the swap; then a top-up request is approved with a signed transaction and
// pulled. The model is scripted; Telegram is not involved (covered in apps/server tests).
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateAgentKeypair,
  listDelegations,
  loadLocalKeypair,
  parseManifest,
  SURFPOOL_URL,
  sendAndConfirm,
} from "@syndromi/core";
import {
  ActivityLog,
  call,
  finish,
  HttpApprovalGateway,
  memorySink,
  prepareAgent,
  runOnce,
  ScriptedProvider,
  ServerClient,
  useTools,
} from "@syndromi/runtime";
import { createContext, HostedRuntime, listen, Store } from "@syndromi/server";
import { createToolset } from "@syndromi/tools";
import { afterAll, describe, expect, it } from "vitest";
import type { Io } from "./io.js";
import { main } from "./main.js";

const surfpoolUp = await fetch(SURFPOOL_URL, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
  signal: AbortSignal.timeout(1000),
})
  .then((r) => r.ok)
  .catch(() => false);
if (!surfpoolUp) console.warn("approvals e2e skipped: Surfpool is not running on :8899");

const quietIo = (): Io & { lines: string[] } => {
  const lines: string[] = [];
  return {
    lines,
    print: (l) => void lines.push(l),
    ask: async () => undefined,
    secret: async () => undefined,
  };
};

describe.skipIf(!surfpoolUp)("approvals end to end on the fork", () => {
  const store = new Store(":memory:");
  let server: { port: number; close: () => void } | undefined;
  afterAll(() => server?.close());

  it("draft → owner signs → swap executes; top-up → owner signs tx → pulled", {
    timeout: 300_000,
  }, async () => {
    // Server on a random port.
    const ctx = createContext(store, {
      publicUrl: "http://localhost",
      token: "e2e-token",
      env: {},
      draftTtlMs: 30 * 60 * 1000,
      topUpTtlMs: 60 * 60 * 1000,
      dashboardOrigins: [],
    });
    server = await listen(ctx, 0);
    const url = `http://127.0.0.1:${server.port}`;

    // A fresh owner (the "Phantom" wallet in real life) and agent home.
    const home = await mkdtemp(join(tmpdir(), "syndromi-e2e-"));
    const ownerKey = await generateAgentKeypair();
    const ownerPath = join(home, "owner.json");
    await writeFile(ownerPath, JSON.stringify(Array.from(ownerKey.secretKey)));
    const env = {
      SYNDROMI_HOME: join(home, ".syndromi"),
      SYNDROMI_PASSPHRASE: "e2e passphrase",
      OWNER_KEYPAIR: ownerPath,
      SYNDROMI_SERVER_URL: url,
      SYNDROMI_SERVER_TOKEN: "e2e-token",
    };
    const dir = join(home, "scout");
    const io = quietIo();
    await main(["init", "yield-scout", "--dir", dir], io, env);
    await main(["fund", dir, "--fork"], io, env);

    // 1. A scripted yield-scout run proposes 15 USDC → JitoSOL: needs_approval → server draft.
    const manifestResult = parseManifest(await readFile(join(dir, "manifest.yaml"), "utf8"));
    if (!manifestResult.ok) throw new Error(manifestResult.errors.join("\n"));
    const manifest = manifestResult.manifest;
    const { signer: agentSigner } = await loadLocalKeypair("yield-scout", env.SYNDROMI_PASSPHRASE, {
      root: env.SYNDROMI_HOME,
    });
    const agent = prepareAgent({
      manifest,
      cluster: "fork",
      agentSigner,
      owner: ownerKey.signer.address,
      env,
    });
    const client = new ServerClient({ url, token: "e2e-token" });
    await client.register({
      name: "yield-scout",
      address: agentSigner.address,
      owner: ownerKey.signer.address,
      cluster: "fork",
      allowanceMint: agent.ctx.allowanceMint,
      rules: { maxTxUsd: 25, approveAboveUsd: 10, destinations: ["self"], programs: ["jupiter"] },
    });
    const sink = memorySink();
    const summary = await runOnce({
      manifest,
      prompt: "Move idle USDC into JitoSOL.",
      provider: new ScriptedProvider([
        useTools(call("pull-allowance", { amount: 15 })),
        useTools(call("jupiter-swap", { from: "USDC", to: "JitoSOL", amount: 15 })),
        finish("Proposed 15 USDC → JitoSOL for approval."),
      ]),
      tools: createToolset(manifest.tools),
      signer: agent.signer,
      ctx: agent.ctx,
      log: new ActivityLog("yield-scout", [sink]),
      approvals: new HttpApprovalGateway(client, "yield-scout"),
      send: (tx) => sendAndConfirm(agent.rpc, tx),
    });
    expect(sink.events.filter((e) => e.type === "error")).toEqual([]);
    expect(summary.sent).toHaveLength(1); // the pull
    const [draftId] = summary.drafts;
    expect(draftId).toMatch(/^d_/);
    expect((await store.draft(String(draftId)))?.status).toBe("pending");

    // 2. The owner approves through the Actions endpoints (sign-message), from the terminal.
    await main(["approve", String(draftId)], io, env);
    expect((await store.draft(String(draftId)))?.status).toBe("approved");

    // 3. The watcher re-verifies, re-quotes, and executes on the fork.
    await main(["watch", dir, "--once", "--fork"], io, env);
    const executed = await store.draft(String(draftId));
    expect(executed?.status, executed?.resultError).toBe("executed");
    expect(executed?.resultSignature).toBeTruthy();

    // 4. Top-up: request → owner signs the grantTopUp transaction → confirmed → pulled.
    await main(
      ["request-topup", dir, "--amount", "5", "--reason", "e2e top-up", "--fork"],
      io,
      env,
    );
    const [topup] = await store.topUps({ agentName: "yield-scout" });
    expect(topup?.status).toBe("pending");
    await main(["approve", String(topup?.id), "--fork"], io, env);
    expect((await store.topUp(String(topup?.id)))?.status).toBe("approved");
    await main(["watch", dir, "--once", "--fork"], io, env);
    const pulled = await store.topUp(String(topup?.id));
    expect(pulled?.status, pulled?.resultError).toBe("pulled");

    // 5. A local agent registered from the CLI is funded through the fund-agent Action (what the
    //    dashboard wizard signs), then the kill switch revokes everything in one signature.
    const dcaDir = join(home, "dca");
    await main(
      ["init", "dca-agent", "--dir", dcaDir, "--owner", ownerKey.signer.address, "--fork"],
      io,
      env,
    );
    expect(await store.agent("dca-agent")).toMatchObject({
      runtime: "local",
      allowance: { amount: 20 },
    });
    await main(["action", "/actions/fund-agent/dca-agent", "--fork"], io, env);
    const funded = await listDelegations(agent.rpc, ownerKey.signer.address);
    expect(funded.filter((d) => d.kind === "allowance")).toHaveLength(2);
    expect(io.lines.join("\n")).toMatch(/Funded/);

    await main(["action", "/actions/kill-switch?cluster=fork", "--fork"], io, env);
    expect(await listDelegations(agent.rpc, ownerKey.signer.address)).toEqual([]);
    expect(io.lines.join("\n")).toMatch(/Everything revoked/);
  });

  it("hosted: deploy → fund → the server runs it → owner approves → the server executes", {
    timeout: 300_000,
  }, async () => {
    const hostedStore = new Store(":memory:");
    const ctx = createContext(hostedStore, {
      publicUrl: "http://localhost",
      token: "e2e-token",
      env: { SYNDROMI_HOSTED_SECRET: "an-e2e-secret-that-is-at-least-32-chars" },
      draftTtlMs: 30 * 60 * 1000,
      topUpTtlMs: 60 * 60 * 1000,
      dashboardOrigins: [],
    });
    // The server runs the agent with a scripted model: pull 15 USDC, propose a $15 swap.
    const hosted = new HostedRuntime(ctx, {
      schedule: false,
      providerFor: () =>
        new ScriptedProvider([
          useTools(call("pull-allowance", { amount: 15 })),
          useTools(call("jupiter-swap", { from: "USDC", to: "JitoSOL", amount: 15 })),
          finish("Proposed 15 USDC → JitoSOL."),
        ]),
    });
    ctx.hosted = hosted;
    const hostedServer = await listen(ctx, 0);
    try {
      const home = await mkdtemp(join(tmpdir(), "syndromi-hosted-"));
      const ownerKey = await generateAgentKeypair();
      const ownerPath = join(home, "owner.json");
      await writeFile(ownerPath, JSON.stringify(Array.from(ownerKey.secretKey)));
      const env = {
        SYNDROMI_HOME: join(home, ".syndromi"),
        OWNER_KEYPAIR: ownerPath,
        SYNDROMI_SERVER_URL: `http://127.0.0.1:${hostedServer.port}`,
        SYNDROMI_SERVER_TOKEN: "e2e-token",
      };
      const io = quietIo();
      const owner = ownerKey.signer.address;
      await fetch(SURFPOOL_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "surfnet_setAccount",
          params: [owner, { lamports: 2_000_000_000 }],
        }),
      });
      await fetch(SURFPOOL_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "surfnet_setTokenAccount",
          params: [owner, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", { amount: 100_000_000 }],
        }),
      });

      await main(
        ["deploy", join(ROOT, "templates/yield-scout"), "--fork", "--owner", owner],
        io,
        env,
      );
      expect(await hostedStore.agent("yield-scout")).toMatchObject({
        runtime: "hosted",
        cluster: "fork",
      });
      await main(["action", "/actions/fund-agent/yield-scout", "--fork"], io, env);

      await hosted.runAndWait("yield-scout");
      const [draft] = await hostedStore.drafts({ agentName: "yield-scout" });
      expect(draft?.status).toBe("pending");

      await main(["approve", String(draft?.id)], io, env);
      await hosted.watchAll();
      const executed = await hostedStore.draft(String(draft?.id));
      expect(executed?.status, executed?.resultError).toBe("executed");
    } finally {
      hosted.stop();
      hostedServer.close();
    }
  });
});

const ROOT = new URL("../../../", import.meta.url).pathname;
