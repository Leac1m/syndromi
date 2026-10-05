#!/usr/bin/env node
// syndromi: create, fund, run, and revoke budgeted Solana agents.
import { parseArgs } from "node:util";
import { redact } from "@syndromi/core";
import { action } from "./commands/action.js";
import { approve } from "./commands/approve.js";
import { deploy } from "./commands/deploy.js";
import { faucet } from "./commands/faucet.js";
import { fund } from "./commands/fund.js";
import { init } from "./commands/init.js";
import { mcp } from "./commands/mcp.js";
import { requestTopUp } from "./commands/request-topup.js";
import { revoke } from "./commands/revoke.js";
import { run } from "./commands/run.js";
import { status } from "./commands/status.js";
import { watch } from "./commands/watch.js";
import { clusterFrom, type Env } from "./context.js";
import { CliError, type Io, terminalIo } from "./io.js";

export const DEFAULT_TEMPLATE = "mcp-agent";

const HELP = `syndromi <command>

  init [template|dir] [--dir <path>] [--server <url> --owner <address>]
                                          copy a template (default: mcp-agent, a wallet for Claude
                                          or any MCP client) and create the agent's encrypted key;
                                          with a server, register it for funding in the dashboard
  faucet [--server <url>]                 owner: get devnet test USDC from the server's faucet
  fund <dir>                              owner: send the fee budget and grant the allowance
  run <dir> [--once] [--server <url>] [--max-steps n] [--model [nvidia|gemini|anthropic:]id]
                                          run now (--once) or on the schedule; with a server,
                                          drafts go to Telegram and approvals are executed
  mcp <dir> [--server <url>]              serve the agent's tools over MCP (stdio) so any MCP client
                                          (Claude, Cursor) can act as the agent, under the same policy
  watch <dir> [--once] [--server <url>]   execute owner approvals only (no LLM)
  deploy <dir> [--owner <address>] [--server <url>]
                                          run the agent hosted: the server creates its key and
                                          runs it on the manifest schedule
  approve <id> [--reject] [--server <url>]   owner: approve or reject from the terminal
  action <path> [--server <url>]          owner: run a server Action with the CLI key, e.g.
                                          /actions/fund-agent/<name>, "/actions/kill-switch?cluster=devnet"
  request-topup <dir> --amount n --reason "…" [--server <url>]
  status                                  list the bag's delegations and what is left
  revoke --all | --agent <name> [--hard]  kill switch: revoke delegations

Cluster: devnet by default; --fork for a local Surfpool mainnet fork; --mainnet (asks to confirm).
Env: SYNDROMI_PASSPHRASE, OWNER_KEYPAIR, SYNDROMI_HOME, RPC_API_KEY, SYNDROMI_SERVER_URL,
SYNDROMI_SERVER_TOKEN, SYNDROMI_CONFIRM_MAINNET (mcp --mainnet), plus the manifest's api_key_env.`;

export async function main(argv: string[], io: Io = terminalIo, env: Env = process.env) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      dir: { type: "string" },
      once: { type: "boolean" },
      "max-steps": { type: "string" },
      model: { type: "string" },
      server: { type: "string" },
      owner: { type: "string" },
      reject: { type: "boolean" },
      amount: { type: "string" },
      reason: { type: "string" },
      fork: { type: "boolean" },
      mainnet: { type: "boolean" },
      all: { type: "boolean" },
      agent: { type: "string" },
      hard: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, positional] = positionals;
  // `syndromi init` with no argument creates the default template, for an agent you already have.
  const target = positional ?? (command === "init" ? DEFAULT_TEMPLATE : undefined);
  const cluster = clusterFrom(values);
  const needTarget = () => {
    if (!target) throw new CliError(`usage: syndromi ${command} <dir>`);
    return target;
  };
  switch (values.help ? "help" : command) {
    case "init":
      return init(
        needTarget(),
        {
          cluster,
          ...(values.dir ? { dir: values.dir } : {}),
          ...(values.server ? { server: values.server } : {}),
          ...(values.owner ? { owner: values.owner } : {}),
        },
        io,
        env,
      );
    case "faucet":
      return faucet({ cluster, ...(values.server ? { server: values.server } : {}) }, io, env);
    case "fund":
      return fund(needTarget(), { cluster }, io, env);
    case "run": {
      const maxSteps = values["max-steps"] ? Number(values["max-steps"]) : undefined;
      return run(
        needTarget(),
        {
          cluster,
          once: Boolean(values.once),
          ...(maxSteps ? { maxSteps } : {}),
          ...(values.model ? { model: values.model } : {}),
          ...(values.server ? { server: values.server } : {}),
        },
        io,
        env,
      );
    }
    case "mcp":
      return mcp(
        needTarget(),
        { cluster, ...(values.server ? { server: values.server } : {}) },
        io,
        env,
      );
    case "watch":
      return watch(
        needTarget(),
        {
          cluster,
          once: Boolean(values.once),
          ...(values.server ? { server: values.server } : {}),
        },
        io,
        env,
      );
    case "approve":
      return approve(
        needTarget(),
        {
          cluster,
          ...(values.reject ? { reject: true } : {}),
          ...(values.server ? { server: values.server } : {}),
        },
        io,
        env,
      );
    case "action":
      return action(
        needTarget(),
        { cluster, ...(values.server ? { server: values.server } : {}) },
        io,
        env,
      );
    case "deploy":
      return deploy(
        needTarget(),
        {
          cluster,
          ...(values.owner ? { owner: values.owner } : {}),
          ...(values.server ? { server: values.server } : {}),
        },
        io,
        env,
      );
    case "request-topup":
      return requestTopUp(
        needTarget(),
        {
          cluster,
          ...(values.amount ? { amount: values.amount } : {}),
          ...(values.reason ? { reason: values.reason } : {}),
          ...(values.server ? { server: values.server } : {}),
        },
        io,
        env,
      );
    case "status":
      return status({ cluster }, io, env);
    case "revoke":
      return revoke(
        {
          cluster,
          ...(values.all ? { all: true } : {}),
          ...(values.agent ? { agent: values.agent } : {}),
          ...(values.hard ? { hard: true } : {}),
        },
        io,
        env,
      );
    default:
      io.print(HELP);
      if (command && command !== "help") throw new CliError(`unknown command: ${command}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(
    () => process.exit(0),
    (error: Error) => {
      console.error(
        redact(error instanceof CliError ? error.message : (error.stack ?? String(error))),
      );
      process.exit(1);
    },
  );
}
