import { type Address, address } from "@solana/kit";

export type Network = "devnet" | "mainnet";

export type TokenInfo = {
  symbol: string;
  decimals: number;
  mints: { mainnet: Address; devnet?: Address };
  /** Pyth price feed id (hex, no 0x), from Hermes /v2/price_feeds. */
  pythFeedId?: string;
};

// Mainnet mints are verified via Jupiter's token list (isVerified) and Phase-1 swaps. Spoofed
// lookalikes exist, so mints are only ever resolved through this registry, never from untrusted
// input.
//
// The devnet mints are syndromí's own test tokens (classic SPL Token, no freeze authority; the
// beta treasury is their mint authority), created by scripts/beta-setup.ts and handed out by the
// server's faucet. They are the mainnet tokens' devnet twins: same symbol and decimals, priced as
// the mainnet token, worth nothing. Circle's devnet USDC is no longer used.
export const TOKENS: readonly TokenInfo[] = [
  {
    symbol: "USDC",
    decimals: 6,
    mints: {
      mainnet: address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
      devnet: address("8wvXYteqfNieCn4RVC8rnDSGgugHkMbPT4x8KnMeneVd"),
    },
    pythFeedId: "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
  },
  {
    symbol: "SOL",
    decimals: 9,
    mints: { mainnet: address("So11111111111111111111111111111111111111112") },
    pythFeedId: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  },
  {
    symbol: "JitoSOL",
    decimals: 9,
    mints: {
      mainnet: address("J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn"),
      devnet: address("HHauXVZsFjs1UFCoBJun9dwmCMhbLPVxnmEpxPqRcdpv"),
    },
    pythFeedId: "67be9f519b95cf24338801051f9a808eff0a578ccb388db73b7f6fe1de019ffb",
  },
  {
    symbol: "mSOL",
    decimals: 9,
    mints: { mainnet: address("mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So") },
    pythFeedId: "c2289a6a43d2ce91c6f55caec370f4acc38a2ed477f58813334c6d03749ff2a4",
  },
];

/** Resolve a symbol (case-insensitive) or a registered mint address on a network. */
export function findToken(symbolOrMint: string, network: Network): TokenInfo | undefined {
  const needle = symbolOrMint.toLowerCase();
  return TOKENS.find(
    (t) =>
      t.symbol.toLowerCase() === needle ||
      t.mints.mainnet === symbolOrMint ||
      t.mints[network] === symbolOrMint,
  );
}

/** The token a mint belongs to, on any network (devnet mints price as their mainnet twin). */
export function tokenByMint(mint: Address): TokenInfo | undefined {
  return TOKENS.find((t) => t.mints.mainnet === mint || t.mints.devnet === mint);
}

export function mintFor(token: TokenInfo, network: Network): Address {
  const mint = token.mints[network];
  if (!mint) throw new Error(`${token.symbol} has no ${network} mint in the registry`);
  return mint;
}

/** Base units → UI amount as a number (fine for USD math at our sizes). */
export function toUiAmount(amount: bigint, decimals: number): number {
  return Number(amount) / 10 ** decimals;
}

/** UI amount → base units, rounded to the token's precision. */
export function toBaseUnits(amount: number, decimals: number): bigint {
  const [whole = "0", frac = ""] = amount.toFixed(decimals).split(".");
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

/** Decimals of a registered mint; unregistered mints are assumed to have 6, like USDC. */
export function decimalsOf(mint: Address): number {
  return tokenByMint(mint)?.decimals ?? 6;
}

/** "12.5 USDC" for a registered mint, "12.5 tokens" for any other. */
export function formatTokenAmount(mint: Address, amount: bigint): string {
  return `${toUiAmount(amount, decimalsOf(mint))} ${tokenByMint(mint)?.symbol ?? "tokens"}`;
}
