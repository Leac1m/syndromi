// `syndromi approve <id> [--reject]`: the owner approves from the terminal with the CLI key,
// through the same Actions endpoints a wallet uses. Needed for fork agents (Phantom cannot
// reach Surfpool) and for automated end-to-end tests.
import type { Cluster } from "@syndromi/core";
import { confirmMainnet, type Env, loadOwner } from "../context.js";
import { CliError, type Io } from "../io.js";
import { runOwnerAction } from "../owner-action.js";
import { requireServer } from "../session.js";

export async function approve(
  id: string,
  opts: { cluster: Cluster; reject?: boolean; server?: string },
  io: Io,
  env: Env,
) {
  const kind = id.startsWith("d_") ? "draft" : id.startsWith("t_") ? "topup" : undefined;
  if (!kind) throw new CliError(`"${id}" is not a draft (d_…) or top-up (t_…) id`);
  const { url, client } = requireServer(opts.server, env);
  if (opts.reject) {
    await client.reject(kind, id);
    io.print(`rejected ${id}`);
    return { status: "rejected" };
  }
  const owner = await loadOwner(env);
  return runOwnerAction(url, `/actions/approve-${kind}/${id}`, owner, io, () =>
    confirmMainnet(opts.cluster, io, `approve ${id}`),
  );
}
