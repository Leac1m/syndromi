import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getBase58Encoder,
  getUtf8Encoder,
  type SignatureBytes,
  verifySignature,
} from "@solana/kit";
import { generateAgentKeypair } from "@syndromi/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CliError, type Io } from "./io.js";
import { main } from "./main.js";

function fakeIo(answers: (string | undefined)[] = []): Io & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    print: (line) => void lines.push(line),
    ask: async () => answers.shift(),
    secret: async () => answers.shift(),
  };
}

async function tempEnv() {
  const home = await mkdtemp(join(tmpdir(), "syndromi-cli-"));
  return {
    home,
    env: {
      SYNDROMI_HOME: join(home, ".syndromi"),
      SYNDROMI_PASSPHRASE: "test passphrase",
      OWNER_KEYPAIR: join(home, "no-such-owner.json"),
    },
  };
}

describe("syndromi faucet", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is devnet only and needs a server", async () => {
    await expect(main(["faucet", "--mainnet"], fakeIo(), {})).rejects.toThrow(/devnet only/);
    await expect(main(["faucet"], fakeIo(), {})).rejects.toThrow(/no server/);
  });

  it("signs in with the owner key, claims, and reports a refusal with its next time", async () => {
    const { home } = await tempEnv();
    const keyFile = join(home, "owner.json");
    const owner = await generateAgentKeypair();
    await writeFile(keyFile, JSON.stringify([...owner.secretKey]));
    const env = { OWNER_KEYPAIR: keyFile, SYNDROMI_SERVER_URL: "https://api.example/" };
    const text = "Sign in to syndromi";
    let refuse = false;
    const calls: { path: string; body: Record<string, string>; auth: string | null }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(url)).pathname;
        const body = JSON.parse(String(init?.body)) as Record<string, string>;
        calls.push({ path, body, auth: new Headers(init?.headers).get("authorization") });
        if (path === "/owner/session/challenge") return Response.json({ nonce: "n1", text });
        if (path === "/owner/session") return Response.json({ token: "session-token" });
        if (refuse) {
          return Response.json(
            { error: "you already claimed test tokens today", nextAt: "2026-10-06T00:00:00.000Z" },
            { status: 429 },
          );
        }
        return Response.json({ amount: 100, symbol: "USDC", signature: "5ig" });
      }),
    );

    const io = fakeIo();
    await main(["faucet"], io, env);
    expect(calls.map((c) => c.path)).toEqual([
      "/owner/session/challenge",
      "/owner/session",
      "/owner/faucet",
    ]);
    expect(calls[0]?.body.owner).toBe(owner.signer.address);
    // The session is opened with the owner's signature over the server's text, and the claim
    // carries that session.
    const signed = getBase58Encoder().encode(calls[1]?.body.signature ?? "");
    expect(
      await verifySignature(
        owner.signer.keyPair.publicKey,
        signed as SignatureBytes,
        getUtf8Encoder().encode(text),
      ),
    ).toBe(true);
    expect(calls[2]?.auth).toBe("Bearer session-token");
    expect(io.lines.join("\n")).toMatch(/100 test USDC sent to .*\n.*cluster=devnet/);

    refuse = true;
    await expect(main(["faucet"], fakeIo(), env)).rejects.toThrow(
      /already claimed test tokens today \(next claim after 2026-10-06/,
    );
  });
});

describe("syndromi CLI", () => {
  it("prints help, and rejects unknown commands and conflicting clusters", async () => {
    const io = fakeIo();
    await main([], io, {});
    expect(io.lines.join("\n")).toMatch(/init \[template\|dir\]/);
    await expect(main(["launch"], fakeIo(), {})).rejects.toThrow(CliError);
    await expect(main(["status", "--fork", "--mainnet"], fakeIo(), {})).rejects.toThrow(
      /pick one of --fork and --mainnet/,
    );
  });

  it("init copies a template and stores an encrypted key with owner-only permissions", async () => {
    const { home, env } = await tempEnv();
    const dir = join(home, "my-dca");
    const io = fakeIo();
    await main(["init", "dca-agent", "--dir", dir], io, env);

    expect(await readFile(join(dir, "prompt.md"), "utf8")).toMatch(/dollar-cost-averaging/);
    const agentHome = join(env.SYNDROMI_HOME, "agents", "dca-agent");
    const config = JSON.parse(await readFile(join(agentHome, "agent.json"), "utf8"));
    expect(config).toMatchObject({ name: "dca-agent", address: expect.any(String) });
    expect(config.owner).toBeUndefined();
    const key = await stat(join(agentHome, "keypair.enc.json"));
    expect(key.mode & 0o777).toBe(0o600);
    expect(io.lines.join("\n")).toMatch(/next\s+syndromi fund/);

    // The same agent name cannot be created twice.
    await expect(main(["init", dir], fakeIo(), env)).rejects.toThrow(/already exists/);
  });

  it("init with no argument creates the default mcp-agent and prints the Claude command", async () => {
    const { home, env } = await tempEnv();
    const dir = join(home, "my-claude");
    const io = fakeIo();
    await main(["init", "--dir", dir], io, env);
    expect(await readFile(join(dir, "prompt.md"), "utf8")).toMatch(
      /wallet that belongs to its owner/,
    );
    const agentHome = join(env.SYNDROMI_HOME, "agents", "mcp-agent");
    expect(JSON.parse(await readFile(join(agentHome, "agent.json"), "utf8"))).toMatchObject({
      name: "mcp-agent",
    });
    const out = io.lines.join("\n");
    expect(out).toMatch(/claude mcp add syndromi-mcp-agent .*syndromi mcp /);
    expect(out).toContain("pnpm --silent");
  });

  it("run and deploy refuse an external agent and point at syndromi mcp", async () => {
    const { home, env } = await tempEnv();
    const dir = join(home, "ext");
    await main(["init", "mcp-agent", "--dir", dir], fakeIo(), env);
    await expect(main(["run", dir, "--once"], fakeIo(), env)).rejects.toThrow(
      /external agent: an MCP client is its brain. Start it with: syndromi mcp/,
    );
    await expect(
      main(["deploy", dir, "--server", "http://127.0.0.1:1"], fakeIo(), {
        ...env,
        SYNDROMI_SERVER_TOKEN: "x",
      }),
    ).rejects.toThrow(/cannot be hosted/);
  });

  it("refuses mainnet without a typed confirmation, before touching the owner wallet", async () => {
    const { home, env } = await tempEnv();
    const dir = join(home, "scout");
    await main(["init", "yield-scout", "--dir", dir], fakeIo(), env);

    // No terminal: no answer. OWNER_KEYPAIR does not exist, so reaching it would fail differently.
    await expect(main(["fund", dir, "--mainnet"], fakeIo([undefined]), env)).rejects.toThrow(
      /mainnet not confirmed; nothing was sent/,
    );
    await expect(main(["fund", dir, "--mainnet"], fakeIo(["yes"]), env)).rejects.toThrow(
      /mainnet not confirmed/,
    );
    await expect(main(["revoke", "--all", "--mainnet"], fakeIo(["no"]), env)).rejects.toThrow(
      /mainnet not confirmed/,
    );
    // Typing "mainnet" gets past the guard (and then fails on the missing owner key).
    await expect(main(["fund", dir, "--mainnet"], fakeIo(["mainnet"]), env)).rejects.toThrow(
      /owner keypair not found/,
    );
  });

  it("run explains the next step when the agent has no allowance yet", async () => {
    const { home, env } = await tempEnv();
    const dir = join(home, "dca");
    await main(["init", "dca-agent", "--dir", dir], fakeIo(), env);
    await expect(main(["run", dir, "--once"], fakeIo(), env)).rejects.toThrow(
      /no allowance yet; run: syndromi fund/,
    );
  });
});
