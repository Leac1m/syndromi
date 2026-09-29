// `syndromi action <path>`: run any of the server's owner Actions with the CLI key, e.g.
//   syndromi action /actions/fund-agent/dca-agent
//   syndromi action "/actions/kill-switch?cluster=fork"
import type { Cluster } from "@syndromi/core";
import { confirmMainnet, type Env, loadOwner } from "../context.js";
import { CliError, type Io } from "../io.js";
import { runOwnerAction } from "../owner-action.js";
import { requireServer } from "../session.js";

export async function action(
  path: string,
  opts: { cluster: Cluster; server?: string },
  io: Io,
  env: Env,
) {
  if (!path.startsWith("/actions/")) throw new CliError('the path must start with "/actions/"');
  const { url } = requireServer(opts.server, env);
  const owner = await loadOwner(env);
  return runOwnerAction(url, path, owner, io, () =>
    confirmMainnet(opts.cluster, io, `sign ${path}`),
  );
}
