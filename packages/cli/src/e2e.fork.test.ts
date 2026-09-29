// Day-4 done-when, automated on a Surfpool fork: a yield-scout draft goes to the approvals
// server, the owner approves it through the real Actions endpoints (sign-message), and the
// watcher executes the swap; then a top-up request is approved with a signed transaction and
// pulled. The model is scripted; Telegram is not involved (covered in apps/server tests).
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateAgentKeypair,
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
import { createContext, listen, Store } from "@syndromi/server";
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
    expect(store.draft(String(draftId))?.status).toBe("pending");

    // 2. The owner approves through the Actions endpoints (sign-message), from the terminal.
    await main(["approve", String(draftId)], io, env);
    expect(store.draft(String(draftId))?.status).toBe("approved");

    // 3. The watcher re-verifies, re-quotes, and executes on the fork.
    await main(["watch", dir, "--once", "--fork"], io, env);
    const executed = store.draft(String(draftId));
    expect(executed?.status, executed?.resultError).toBe("executed");
    expect(executed?.resultSignature).toBeTruthy();

    // 4. Top-up: request → owner signs the grantTopUp transaction → confirmed → pulled.
    await main(
      ["request-topup", dir, "--amount", "5", "--reason", "e2e top-up", "--fork"],
      io,
      env,
    );
    const [topup] = store.topUps({ agentName: "yield-scout" });
    expect(topup?.status).toBe("pending");
    await main(["approve", String(topup?.id), "--fork"], io, env);
    expect(store.topUp(String(topup?.id))?.status).toBe("approved");
    await main(["watch", dir, "--once", "--fork"], io, env);
    const pulled = store.topUp(String(topup?.id));
    expect(pulled?.status, pulled?.resultError).toBe("pulled");
  });
});
