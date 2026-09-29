// One way to send, on every cluster: simulate (to surface program logs), send with
// skipPreflight, then poll signature status over HTTP. kit's plugin sendTransaction estimates
// resource limits with its own simulation first, which on Surfpool 1.6 intermittently stalls on
// a remote account fetch and surfaces as "Cannot destructure property 'err' of 'data'".
import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  type GetLatestBlockhashApi,
  type GetSignatureStatusesApi,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  type Instruction,
  pipe,
  type Rpc,
  type SendTransactionApi,
  type Signature,
  type SimulateTransactionApi,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Transaction,
  type TransactionSigner,
} from "@solana/kit";

export type SendRpc = Rpc<
  SimulateTransactionApi & SendTransactionApi & GetSignatureStatusesApi & GetLatestBlockhashApi
>;

export class SendError extends Error {
  constructor(
    message: string,
    readonly logs: readonly string[] = [],
    readonly signature?: Signature,
  ) {
    super(logs.length ? `${message}\n${logs.slice(-6).join("\n")}` : message);
    this.name = "SendError";
  }
}

export async function sendAndConfirm(
  rpc: SendRpc,
  signed: Transaction,
  opts: { timeoutMs?: number } = {},
): Promise<Signature> {
  const wire = getBase64EncodedWireTransaction(signed);
  const sim = await rpc.simulateTransaction(wire, { encoding: "base64" }).send();
  if (sim.value.err) {
    throw new SendError(`simulation failed: ${stringify(sim.value.err)}`, sim.value.logs ?? []);
  }
  const signature = getSignatureFromTransaction(signed);
  await rpc.sendTransaction(wire, { encoding: "base64", skipPreflight: true }).send();
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  while (Date.now() < deadline) {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    const status = value[0];
    if (status?.err) {
      throw new SendError(`transaction failed: ${stringify(status.err)}`, [], signature);
    }
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      return signature;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new SendError(`not confirmed in time`, [], signature);
}

/** Owner-side convenience: a fresh v0 message from instructions, signed by their signers. */
export async function signAndSend(
  rpc: SendRpc,
  payer: TransactionSigner,
  instructions: readonly Instruction[],
): Promise<Signature> {
  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const signed = await signTransactionMessageWithSigners(
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(payer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    ),
  );
  return sendAndConfirm(rpc, signed);
}

function stringify(value: unknown) {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}
