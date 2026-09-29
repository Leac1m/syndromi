export const SERVER = (process.env.NEXT_PUBLIC_SYNDROMI_SERVER ?? "http://127.0.0.1:8787").replace(
  /\/+$/,
  "",
);

export type Network = "devnet" | "mainnet";

export function explorerTx(signature: string, network: Network) {
  return `https://explorer.solana.com/tx/${signature}${network === "devnet" ? "?cluster=devnet" : ""}`;
}

export const short = (address: string) => `${address.slice(0, 4)}…${address.slice(-4)}`;
