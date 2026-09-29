#!/usr/bin/env node
// syndromi: create, fund, run, and revoke budgeted Solana agents.
import { parseArgs } from "node:util";
import { redact } from "@syndromi/core";
import { fund } from "./commands/fund.js";
import { init } from "./commands/init.js";
import { revoke } from "./commands/revoke.js";
import { run } from "./commands/run.js";
import { status } from "./commands/status.js";
import { clusterFrom, type Env } from "./context.js";
import { CliError, type Io, terminalIo } from "./io.js";

const HELP = `syndromi <command>

  init <template|dir> [--dir <path>]   copy a template and create the agent's encrypted key
  fund <dir>                           owner: send the fee budget and grant the allowance
  run <dir> [--once] [--max-steps n]   run the agent now (--once) or on its schedule
  status                               list the bag's delegations and what is left
  revoke --all | --agent <name> [--hard]   kill switch: revoke delegations

Cluster: devnet by default; --fork for a local Surfpool mainnet fork; --mainnet (asks to confirm).
Env: SYNDROMI_PASSPHRASE, OWNER_KEYPAIR, SYNDROMI_HOME, RPC_API_KEY, plus the manifest's api_key_env.`;

export async function main(argv: string[], io: Io = terminalIo, env: Env = process.env) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      dir: { type: "string" },
      once: { type: "boolean" },
      "max-steps": { type: "string" },
      fork: { type: "boolean" },
      mainnet: { type: "boolean" },
      all: { type: "boolean" },
      agent: { type: "string" },
      hard: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, target] = positionals;
  const cluster = clusterFrom(values);
  const needTarget = () => {
    if (!target) throw new CliError(`usage: syndromi ${command} <dir>`);
    return target;
  };
  switch (values.help ? "help" : command) {
    case "init":
      return init(needTarget(), values.dir ? { dir: values.dir } : {}, io, env);
    case "fund":
      return fund(needTarget(), { cluster }, io, env);
    case "run": {
      const maxSteps = values["max-steps"] ? Number(values["max-steps"]) : undefined;
      return run(
        needTarget(),
        { cluster, once: Boolean(values.once), ...(maxSteps ? { maxSteps } : {}) },
        io,
        env,
      );
    }
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
