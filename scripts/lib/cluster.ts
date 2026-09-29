// RPC endpoints and explorer links for the spikes. Devnet by default; mainnet is read-only here.

export type Cluster = "devnet" | "mainnet";

function apiKey(): string {
  const key = process.env.RPC_API_KEY;
  if (!key) throw new Error("RPC_API_KEY is not set. Copy .env.example to .env and fill it in.");
  return key;
}

export function heliusUrl(cluster: Cluster): string {
  const host = cluster === "devnet" ? "devnet.helius-rpc.com" : "mainnet.helius-rpc.com";
  return `https://${host}/?api-key=${apiKey()}`;
}

export const SURFPOOL_URL = "http://127.0.0.1:8899";

export function explorerTx(signature: string, cluster: Cluster | "surfpool"): string {
  if (cluster === "mainnet") return `https://explorer.solana.com/tx/${signature}`;
  if (cluster === "devnet") return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
  const custom = encodeURIComponent(SURFPOOL_URL);
  return `https://explorer.solana.com/tx/${signature}?cluster=custom&customUrl=${custom}`;
}

/** Strip the API key before printing anything that might contain a URL. */
export function redact(text: string): string {
  const key = process.env.RPC_API_KEY;
  return key ? text.replaceAll(key, "***") : text;
}
