// Helpers for spikes that run on a local Surfpool mainnet fork.
import {
  createSolanaRpc,
  getBase64EncodedWireTransaction,
  type Signature,
  type Transaction,
} from "@solana/kit";
import { SURFPOOL_URL } from "./cluster.js";

export const forkRpc = createSolanaRpc(SURFPOOL_URL);

export async function assertSurfpoolRunning() {
  try {
    await forkRpc.getHealth().send();
  } catch {
    console.error(`Surfpool is not reachable at ${SURFPOOL_URL}. Start it first:
  surfpool start --no-tui --rpc-url "https://mainnet.helius-rpc.com/?api-key=$RPC_API_KEY"`);
    process.exit(1);
  }
}

/** Calls a surfnet_* cheatcode (e.g. surfnet_setAccount, surfnet_setTokenAccount). */
export async function cheatcode(method: string, params: unknown[]) {
  const res = await fetch(SURFPOOL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
}

/**
 * Simulates, then sends a signed transaction to the fork and waits for confirmation.
 * Simulating first surfaces the program logs; a failed preflight inside sendTransaction
 * occasionally came back from Surfpool in a shape kit could not parse.
 */
export async function sendToFork(signed: Transaction): Promise<Signature> {
  const wire = getBase64EncodedWireTransaction(signed);
  const sim = await forkRpc.simulateTransaction(wire, { encoding: "base64" }).send();
  if (sim.value.err) {
    const logs = sim.value.logs?.slice(-6).join("\n") ?? "";
    throw new Error(`simulation failed: ${stringify(sim.value.err)}\n${logs}`);
  }
  const signature = await forkRpc
    .sendTransaction(wire, { encoding: "base64", skipPreflight: true })
    .send();
  await waitForConfirmation(signature);
  return signature;
}

// Poll over HTTP: Surfpool's signature subscriptions were flaky with kit's confirmation strategy.
async function waitForConfirmation(signature: Signature) {
  for (let i = 0; i < 30; i++) {
    const { value } = await forkRpc.getSignatureStatuses([signature]).send();
    const status = value[0];
    if (status?.err) throw new Error(`transaction failed: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`not confirmed after 15s: ${signature}`);
}

function stringify(value: unknown) {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}
