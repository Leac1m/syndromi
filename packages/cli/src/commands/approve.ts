// `syndromi approve <id> [--reject]`: the owner approves from the terminal with the CLI key,
// through the same Actions endpoints a wallet uses. Needed for fork agents (Phantom cannot
// reach Surfpool) and for automated end-to-end tests.
import {
  createSolanaRpc,
  decompileTransactionMessage,
  getBase58Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  getUtf8Encoder,
  signBytes,
  signTransaction,
} from "@solana/kit";
import {
  type Cluster,
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  explorerTx,
  rpcUrlFor,
  SUBSCRIPTIONS_PROGRAM_ADDRESS,
  sendAndConfirm,
} from "@syndromi/core";
import { confirmMainnet, type Env, loadOwner } from "../context.js";
import { CliError, type Io } from "../io.js";
import { requireServer } from "../session.js";

type Json = Record<string, unknown>;

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

  const href = `${url}/actions/approve-${kind}/${id}`;
  const action = async (path: string, body?: unknown): Promise<Json> => {
    const res = await fetch(path.startsWith("http") ? path : `${url}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = (await res.json()) as Json;
    if (!res.ok) throw new CliError(String(json.message ?? `HTTP ${res.status}`));
    return json;
  };

  const card = await action(href);
  io.print(`${card.title}\n${card.description}`);
  if (card.disabled) throw new CliError(`not pending (${card.label})`);
  const owner = await loadOwner(env);
  const response = await action(href, { account: owner.address });
  const next = (response.links as { next?: { href: string } } | undefined)?.next?.href;
  if (!next) throw new CliError("the Action returned no follow-up link");

  if (kind === "draft") {
    if (response.type !== "message" || typeof response.data !== "string") {
      throw new CliError("expected a sign-message response");
    }
    io.print(`\nsigning as ${owner.address}:\n${response.data}\n`);
    const signature = getBase58Decoder().decode(
      await signBytes(owner.keyPair.privateKey, getUtf8Encoder().encode(response.data)),
    );
    const done = await action(next, {
      account: owner.address,
      signature,
      data: response.data,
      state: response.state,
    });
    io.print(`${done.title}: ${done.description}`);
    return done;
  }

  // Top-up: check what we are about to sign before signing it.
  if (response.type !== "transaction" || typeof response.transaction !== "string") {
    throw new CliError("expected a transaction response");
  }
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(response.transaction));
  const message = decompileTransactionMessage(
    getCompiledTransactionMessageDecoder().decode(tx.messageBytes),
  );
  if (message.feePayer.address !== owner.address) throw new CliError("the fee payer is not you");
  const allowed = new Set<string>([SUBSCRIPTIONS_PROGRAM_ADDRESS, COMPUTE_BUDGET_PROGRAM_ADDRESS]);
  const unexpected = message.instructions.filter((ix) => !allowed.has(ix.programAddress));
  if (unexpected.length) {
    throw new CliError(`refusing to sign: unexpected program ${unexpected[0]?.programAddress}`);
  }
  await confirmMainnet(opts.cluster, io, `approve top-up ${id}`);
  const signed = await signTransaction([owner.keyPair], tx);
  const rpc = createSolanaRpc(rpcUrlFor(opts.cluster, env));
  const signature = await sendAndConfirm(rpc, signed as Parameters<typeof sendAndConfirm>[1]);
  io.print(`sent ${explorerTx(signature, opts.cluster)}`);
  const done = await action(next, { account: owner.address, signature });
  io.print(`${done.title}: ${done.description}`);
  return done;
}
