export const SERVER = (process.env.NEXT_PUBLIC_SYNDROMI_SERVER ?? "http://127.0.0.1:8787").replace(
  /\/+$/,
  "",
);

/** fork = a local Surfpool mainnet fork (rehearsals); Phantom only signs, the server sends. */
export type Network = "devnet" | "mainnet" | "fork";

/** The fork only exists on a developer's machine, so the switcher offers it only when asked. */
export const NETWORKS: readonly Network[] =
  process.env.NEXT_PUBLIC_SHOW_FORK === "1" ? ["devnet", "fork", "mainnet"] : ["devnet", "mainnet"];

export const SURFPOOL_URL = "http://127.0.0.1:8899";

export function explorerTx(signature: string, network: Network) {
  const base = `https://explorer.solana.com/tx/${signature}`;
  if (network === "devnet") return `${base}?cluster=devnet`;
  if (network === "fork")
    return `${base}?cluster=custom&customUrl=${encodeURIComponent(SURFPOOL_URL)}`;
  return base;
}

export const short = (address: string) => `${address.slice(0, 4)}…${address.slice(-4)}`;
