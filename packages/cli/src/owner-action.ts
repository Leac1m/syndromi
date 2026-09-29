// Drive one of our Actions as the owner, from the terminal, exactly as a wallet would: GET the
// card, POST the owner's account, sign the message or transaction with the CLI key, hand it
// back, and follow chained steps until the flow completes. Used by `approve` and `action`.
import {
  decompileTransactionMessage,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  getUtf8Encoder,
  type KeyPairSigner,
  signBytes,
  signTransaction,
} from "@solana/kit";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import { COMPUTE_BUDGET_PROGRAM_ADDRESS, SUBSCRIPTIONS_PROGRAM_ADDRESS } from "@syndromi/core";
import { CliError, type Io } from "./io.js";

type Json = Record<string, unknown>;

/** Programs an owner-side Action may ask the owner to sign for. */
const OWNER_PROGRAMS = new Set<string>([
  SUBSCRIPTIONS_PROGRAM_ADDRESS,
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  SYSTEM_PROGRAM_ADDRESS,
]);

export async function runOwnerAction(
  base: string,
  path: string,
  owner: KeyPairSigner,
  io: Io,
  beforeSigningTransaction: () => Promise<void> = async () => undefined,
): Promise<Json> {
  const call = async (target: string, body?: unknown): Promise<Json> => {
    const res = await fetch(target.startsWith("http") ? target : `${base}${target}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let json: Json;
    try {
      json = JSON.parse(text) as Json;
    } catch {
      throw new CliError(`${target}: HTTP ${res.status} ${text.slice(0, 120)}`);
    }
    if (!res.ok) throw new CliError(String(json.message ?? `HTTP ${res.status}`));
    return json;
  };

  let card = await call(path);
  for (let step = 0; step < 5; step++) {
    io.print(`${card.title}\n${card.description}`);
    if (card.type === "completed") return card;
    if (card.disabled) throw new CliError(`not available (${card.label})`);
    const link = (card.links as { actions?: { href: string }[] } | undefined)?.actions?.[0];
    const response = await call(link?.href ?? path, { account: owner.address });
    const next = (response.links as { next?: { href: string } } | undefined)?.next?.href;
    if (!next) throw new CliError("the Action returned no follow-up link");

    if (response.type === "message" && typeof response.data === "string") {
      io.print(`\nsigning as ${owner.address}:\n${response.data}\n`);
      const signature = getBase58Decoder().decode(
        await signBytes(owner.keyPair.privateKey, getUtf8Encoder().encode(response.data)),
      );
      card = await call(next, {
        account: owner.address,
        signature,
        data: response.data,
        state: response.state,
      });
      continue;
    }
    if (response.type !== "transaction" || typeof response.transaction !== "string") {
      throw new CliError(`unsupported action response: ${String(response.type)}`);
    }
    // Check what we are about to sign before signing it.
    const tx = getTransactionDecoder().decode(getBase64Encoder().encode(response.transaction));
    const message = decompileTransactionMessage(
      getCompiledTransactionMessageDecoder().decode(tx.messageBytes),
    );
    if (message.feePayer.address !== owner.address) throw new CliError("the fee payer is not you");
    const unexpected = message.instructions.find((ix) => !OWNER_PROGRAMS.has(ix.programAddress));
    if (unexpected)
      throw new CliError(`refusing to sign: unexpected program ${unexpected.programAddress}`);
    if (response.message) io.print(String(response.message));
    await beforeSigningTransaction();
    const signed = await signTransaction([owner.keyPair], tx);
    // Sign here; the server sends it to the right cluster.
    card = await call(next.replace(/\/confirm$/, "/submit"), {
      account: owner.address,
      transaction: getBase64EncodedWireTransaction(signed),
    });
  }
  throw new CliError("too many chained steps");
}
