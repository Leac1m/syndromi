import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
