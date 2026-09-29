// Where an agent runs: devnet (default), a local Surfpool mainnet fork, or mainnet.
import type { Network } from "./tokens.js";

export type Cluster = "devnet" | "fork" | "mainnet";

export const SURFPOOL_URL = "http://127.0.0.1:8899";

/** Which registry mints apply: the fork mirrors mainnet state. */
export function networkOf(cluster: Cluster): Network {
  return cluster === "devnet" ? "devnet" : "mainnet";
}

/** Helius when RPC_API_KEY is set, otherwise the public endpoints (rate-limited). */
export function rpcUrlFor(cluster: Cluster, env: Record<string, string | undefined> = process.env) {
  if (cluster === "fork") return SURFPOOL_URL;
  const key = env.RPC_API_KEY;
  if (cluster === "devnet") {
    return key ? `https://devnet.helius-rpc.com/?api-key=${key}` : "https://api.devnet.solana.com";
  }
  return key
    ? `https://mainnet.helius-rpc.com/?api-key=${key}`
    : "https://api.mainnet-beta.solana.com";
}

export function explorerTx(signature: string, cluster: Cluster): string {
  if (cluster === "mainnet") return `https://explorer.solana.com/tx/${signature}`;
  if (cluster === "devnet") return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
  const custom = encodeURIComponent(SURFPOOL_URL);
  return `https://explorer.solana.com/tx/${signature}?cluster=custom&customUrl=${custom}`;
}

/** Remove the RPC key from anything that might be printed or logged. */
export function redact(text: string, env: Record<string, string | undefined> = process.env) {
  const key = env.RPC_API_KEY;
  return key ? text.replaceAll(key, "***") : text;
}
