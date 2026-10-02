// A server-held external agent through the real HostedRuntime (no stub): it loads from its stored,
// encrypted key with no model and no schedule, and the owner's AI acts through it.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { generateKeyPairSigner } from "@solana/kit";
import { callTool } from "@syndromi/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createContext } from "./context.js";
import { Store } from "./db.js";
import { HostedRuntime } from "./hosted.js";
import { createHostedAgent } from "./owner.js";

const ATTACKER = "AhLo5HbFDsWtnC4EjkUqmyUPHNpYy4sxTVtH1Tz8MMPS";
let runtime: HostedRuntime | undefined;
afterEach(() => runtime?.stop());

describe("server-held external agent", () => {
  it("loads watcher-only and lets the owner's AI act under the policy", async () => {
    const ctx = createContext(new Store(":memory:"), {
      publicUrl: "http://localhost:8787",
      token: "t",
      env: { SYNDROMI_HOSTED_SECRET: "a-test-secret-that-is-at-least-32-chars" },
      draftTtlMs: 60_000,
      topUpTtlMs: 60_000,
      dashboardOrigins: [],
    });
    createApp(ctx);
    const dir = join(import.meta.dirname, "../../../templates/mcp-agent");
    const manifestText = await readFile(join(dir, "manifest.yaml"), "utf8");
    const { parseManifest } = await import("@syndromi/core");
    const parsed = parseManifest(manifestText);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed));
    const manifest = parsed.manifest;

    const owner = (await generateKeyPairSigner()).address;
    const created = await createHostedAgent(ctx, {
      manifest,
      prompt: await readFile(join(dir, "prompt.md"), "utf8"),
      owner,
      cluster: "devnet",
      custody: "server",
    });
    if (!created.ok) throw new Error(JSON.stringify(created.error));

    runtime = new HostedRuntime(ctx, { schedule: true });
    ctx.hosted = runtime;
    const remote = await runtime.remote("mcp-agent", { via: "http", token: "syn_test" });
    expect(remote).toBeDefined();
    expect(remote?.call.tools.describe().map((t) => t.name)).toEqual(manifest.tools);
    expect(remote?.rules.join(" ")).toMatch(/5 USDC per week/);
    expect(runtime.nextRun("mcp-agent")).toBeNull(); // no schedule

    // A top-up request lands in the store for the owner, marked as coming through the token.
    const text = await callTool(
      { id: "1", name: "request-topup", input: { amount: 3, reason: "allowance used up" } },
      (remote as NonNullable<typeof remote>).call,
    );
    expect(text).toContain("requested");
    const [topup] = await ctx.store.topUps({ agentName: "mcp-agent" });
    expect(topup).toMatchObject({ owner, status: "pending", amount: 3_000_000n });
    const feed = await ctx.store.activity({ agentNames: ["mcp-agent"] });
    expect(feed.find((e) => e.type === "topup_requested")).toMatchObject({
      via: "http",
      token: "syn_test",
    });

    // An unknown destination is blocked by the real policy, before anything is sent.
    const blocked = await callTool(
      { id: "2", name: "propose-tx", input: { token: "USDC", to: ATTACKER, amount: 2 } },
      (remote as NonNullable<typeof remote>).call,
    );
    expect(blocked).toContain('"status":"blocked"');

    // Re-registering the same name with another key (say, `syndromi init --server` with a local
    // key) must not re-point a server-held agent: /me would show one wallet while the tools use
    // the key the server loaded, and the owner's allowance would sit on the wrong address.
    const record = await ctx.store.agent("mcp-agent");
    const stranger = (await generateKeyPairSigner()).address;
    await expect(
      ctx.store.upsertAgent({ ...(record as NonNullable<typeof record>), address: stranger }),
    ).rejects.toThrow(/different address/);
    expect((await ctx.store.agent("mcp-agent"))?.address).toBe(record?.address);

    // And if a record ever disagrees with the loaded key (changed behind the server's back), the
    // door refuses instead of acting on a different wallet than the one /me shows.
    await ctx.store.sql.run("update agent_records set data = ? where name = ?", [
      JSON.stringify({ ...record, address: stranger }),
      "mcp-agent",
    ]);
    expect(await runtime.remote("mcp-agent", { via: "http", token: "x" })).toBeUndefined();
    await ctx.store.sql.run("update agent_records set data = ? where name = ?", [
      JSON.stringify(record),
      "mcp-agent",
    ]);

    // A name that is not an external server-held agent is not served.
    expect(await runtime.remote("nobody", { via: "http", token: "x" })).toBeUndefined();
    expect((await ctx.store.agent("mcp-agent"))?.custody).toBe("server");
  }, 60_000);
});
