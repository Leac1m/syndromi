// Owner transactions, one mechanism for every Action the owner signs (fund an agent, approve a
// top-up, kill switch). The server builds the transaction and records what it does; the wallet
// signs; then either
//   POST /actions/tx/:id/submit  {account, transaction}  our clients: the server sends it to the
//                                right cluster (wallets send on their own selected network), or
//   POST /actions/tx/:id/confirm {account, signature}    standard Blink clients that sent it
// and a per-kind completion returns the next chained Action or a CompletedAction.
import type { ActionGetResponse, CompletedAction, TransactionResponse } from "@solana/actions-spec";
import {
  type Address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  decompileTransactionMessage,
  getBase64Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type Instruction,
  isTransactionMessageWithinSizeLimit,
  pipe,
  prependTransactionMessageInstructions,
  type ReadonlyUint8Array,
  type Signature,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import {
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  estimateComputeUnitLimitFactory,
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";
import { type Cluster, sendAndConfirm } from "@syndromi/core";
import type { Hono } from "hono";
import { actionError, actionJson } from "./actions/spec.js";
import type { ServerContext } from "./context.js";

export type OwnerTx = {
  id: string;
  owner: Address;
  cluster: Cluster;
  kind: string;
  /** What the kind's completion needs (e.g. a top-up id or agent name). */
  ref: string;
  description: string;
  status: "issued" | "sent";
  signature?: string;
  createdAt: string;
};

/** The next step (a chained Action) or the end of the flow. */
export type Completion = (
  tx: OwnerTx,
  signature: string | undefined,
) => Promise<ActionGetResponse | CompletedAction>;

/** Each Action module registers what happens after its transaction lands. */
export function onOwnerTxLanded(ctx: ServerContext, kind: string, completion: Completion) {
  ctx.completions.set(kind, completion as never);
}

const PRIORITY_MICRO_LAMPORTS = 10_000n;

/** Would these instructions fit in one transaction (with our compute-budget prefix)? */
export function fitsInOneTransaction(owner: Address, instructions: Instruction[]) {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(owner, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: "11111111111111111111111111111111" as never, lastValidBlockHeight: 0n },
        m,
      ),
    (m) =>
      appendTransactionMessageInstructions(
        [
          getSetComputeUnitLimitInstruction({ units: 1 }),
          getSetComputeUnitPriceInstruction({ microLamports: 1n }),
          ...instructions,
        ],
        m,
      ),
  );
  try {
    return isTransactionMessageWithinSizeLimit(message);
  } catch {
    return false; // e.g. more than 64 accounts
  }
}

export async function issueOwnerTx(
  ctx: ServerContext,
  args: {
    owner: Address;
    cluster: Cluster;
    kind: string;
    ref: string;
    instructions: Instruction[];
    message: string;
  },
): Promise<TransactionResponse> {
  const rpc = ctx.rpc(args.cluster);
  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const unsized = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(args.owner, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(args.instructions, m),
  );
  // Our own compute budget, so wallets have less reason to rewrite the transaction.
  const units = await estimateComputeUnitLimitFactory({ rpc })(unsized).catch(() => 200_000);
  const transaction = compileTransaction(
    prependTransactionMessageInstructions(
      [
        getSetComputeUnitLimitInstruction({ units: Math.min(1_400_000, Math.ceil(units * 1.3)) }),
        getSetComputeUnitPriceInstruction({ microLamports: PRIORITY_MICRO_LAMPORTS }),
      ],
      unsized,
    ),
  );
  const tx: OwnerTx = {
    id: `x_${crypto.randomUUID().slice(0, 12)}`,
    owner: args.owner,
    cluster: args.cluster,
    kind: args.kind,
    ref: args.ref,
    description: describeMessage(transaction.messageBytes),
    status: "issued",
    createdAt: new Date().toISOString(),
  };
  ctx.store.saveOwnerTx(tx);
  return {
    type: "transaction",
    transaction: getBase64EncodedWireTransaction(transaction),
    message: args.message,
    links: { next: { type: "post", href: `/actions/tx/${tx.id}/confirm` } },
  };
}

export function mountOwnerTx(app: Hono, ctx: ServerContext, icon: string) {
  const { store } = ctx;
  const load = (id: string) => store.ownerTx<OwnerTx>(id);

  const finish = async (tx: OwnerTx, signature: string | undefined) => {
    const completion = ctx.completions.get(tx.kind) as Completion | undefined;
    if (completion) return completion(tx, signature);
    const done: CompletedAction = {
      type: "completed",
      icon,
      title: "Done",
      description: "",
      label: "Done",
    };
    return done;
  };

  app.post("/actions/tx/:id/submit", async (c) => {
    const tx = load(c.req.param("id"));
    if (!tx) return actionError(c, "Unknown transaction request.", 404);
    if (tx.status !== "issued")
      return actionError(c, "This transaction was already sent.", 409, tx.cluster);
    const body = (await c.req.json().catch(() => ({}))) as {
      account?: string;
      transaction?: string;
    };
    if (body.account !== tx.owner || !body.transaction) {
      return actionError(c, "Only the bag owner can sign this.", 403, tx.cluster);
    }
    let signed: ReturnType<ReturnType<typeof getTransactionDecoder>["decode"]>;
    let submitted: string;
    try {
      signed = getTransactionDecoder().decode(getBase64Encoder().encode(body.transaction));
      submitted = describeMessage(signed.messageBytes);
    } catch {
      return actionError(c, "Could not read the signed transaction.", 400, tx.cluster);
    }
    // Only what we issued may be sent: same payer, blockhash and instructions. Wallets may add
    // compute-budget instructions (Phantom adds a priority fee) and nothing else.
    if (submitted !== tx.description) {
      return actionError(c, "This is not the transaction that was issued.", 400, tx.cluster);
    }
    let signature: Signature;
    try {
      signature = await sendAndConfirm(
        ctx.rpc(tx.cluster),
        signed as Parameters<typeof sendAndConfirm>[1],
      );
    } catch (e) {
      return actionError(c, `Sending failed: ${(e as Error).message}`, 502, tx.cluster);
    }
    const sent = { ...tx, status: "sent" as const, signature };
    store.saveOwnerTx(sent);
    return actionJson(c, await finish(sent, signature), tx.cluster);
  });

  app.post("/actions/tx/:id/confirm", async (c) => {
    const tx = load(c.req.param("id"));
    if (!tx) return actionError(c, "Unknown transaction request.", 404);
    const body = (await c.req.json().catch(() => ({}))) as { signature?: string };
    if (body.signature && tx.status === "issued") {
      store.saveOwnerTx({ ...tx, status: "sent", signature: body.signature });
    }
    return actionJson(c, await finish(tx, body.signature ?? tx.signature), tx.cluster);
  });
}

/**
 * A canonical description of what a message does, ignoring compute-budget instructions:
 * fee payer, blockhash, and each other instruction's program, accounts (with roles) and data.
 */
export function describeMessage(messageBytes: ReadonlyUint8Array): string {
  const message = decompileTransactionMessage(
    getCompiledTransactionMessageDecoder().decode(messageBytes),
  );
  const b64 = getBase64Decoder();
  return JSON.stringify({
    feePayer: message.feePayer.address,
    blockhash:
      "blockhash" in message.lifetimeConstraint ? message.lifetimeConstraint.blockhash : "nonce",
    instructions: message.instructions
      .filter((ix) => ix.programAddress !== COMPUTE_BUDGET_PROGRAM_ADDRESS)
      .map((ix) => ({
        program: ix.programAddress,
        accounts: (ix.accounts ?? []).map((a) => [a.address, a.role]),
        data: ix.data ? b64.decode(ix.data) : "",
      })),
  });
}
