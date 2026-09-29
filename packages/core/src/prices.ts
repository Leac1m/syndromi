import type { Address } from "@solana/kit";
import { type TokenInfo, tokenByMint } from "./tokens.js";

/** USD price per whole token, or undefined when no trustworthy price is available. */
export interface PriceSource {
  readonly name: string;
  usdPrice(mint: Address): Promise<number | undefined>;
}

type Fetch = typeof fetch;
const CACHE_MS = 30_000;

/** Keyless Jupiter Price API v3. Devnet mints are priced as their mainnet twin. */
export class JupiterPriceSource implements PriceSource {
  readonly name = "jupiter";
  private cache = new Map<Address, { price: number | undefined; at: number }>();

  constructor(private readonly opts: { apiKey?: string; fetch?: Fetch; now?: () => number } = {}) {}

  async usdPrice(mint: Address): Promise<number | undefined> {
    const token = tokenByMint(mint);
    const priceMint = token?.mints.mainnet ?? mint;
    const now = (this.opts.now ?? Date.now)();
    const hit = this.cache.get(priceMint);
    if (hit && now - hit.at < CACHE_MS) return hit.price;

    const headers: Record<string, string> = {};
    if (this.opts.apiKey) headers["x-api-key"] = this.opts.apiKey;
    let price: number | undefined;
    try {
      const res = await (this.opts.fetch ?? fetch)(`https://api.jup.ag/price/v3?ids=${priceMint}`, {
        headers,
      });
      if (res.ok) {
        const body = (await res.json()) as Record<string, { usdPrice?: number } | null>;
        const value = body[priceMint]?.usdPrice;
        price = typeof value === "number" && Number.isFinite(value) ? value : undefined;
      }
    } catch {
      price = undefined;
    }
    this.cache.set(priceMint, { price, at: now });
    return price;
  }
}

/** Pyth Hermes (requires an API key since the Aug 2026 Pyth Core upgrade). */
export class PythPriceSource implements PriceSource {
  readonly name = "pyth";
  private cache = new Map<string, { price: number | undefined; at: number }>();

  constructor(
    private readonly opts: {
      apiKey: string;
      baseUrl?: string;
      fetch?: Fetch;
      now?: () => number;
      /** Reject prices older than this many seconds. */
      maxAgeS?: number;
      /** Called once if Hermes rejects the key (the trial key lapses after 14 days). */
      warn?: (message: string) => void;
    },
  ) {}
  private warned = false;

  async usdPrice(mint: Address): Promise<number | undefined> {
    const token: TokenInfo | undefined = tokenByMint(mint);
    if (!token?.pythFeedId) return undefined;
    const feed = token.pythFeedId;
    const now = (this.opts.now ?? Date.now)();
    const hit = this.cache.get(feed);
    if (hit && now - hit.at < CACHE_MS) return hit.price;

    const base = this.opts.baseUrl ?? "https://pyth.dourolabs.app/hermes";
    let price: number | undefined;
    try {
      const res = await (this.opts.fetch ?? fetch)(
        `${base}/v2/updates/price/latest?ids[]=0x${feed}&parsed=true`,
        { headers: { Authorization: `Bearer ${this.opts.apiKey}` } },
      );
      if ((res.status === 401 || res.status === 403) && !this.warned) {
        this.warned = true;
        (this.opts.warn ?? console.warn)(
          `Pyth rejected PYTH_API_KEY (HTTP ${res.status}); the key may have expired. Prices fall back to Jupiter.`,
        );
      }
      if (res.ok) {
        const body = (await res.json()) as {
          parsed?: { price: { price: string; expo: number; publish_time: number } }[];
        };
        const p = body.parsed?.[0]?.price;
        const fresh = p && now / 1000 - p.publish_time <= (this.opts.maxAgeS ?? 120);
        price = p && fresh ? Number(p.price) * 10 ** p.expo : undefined;
      }
    } catch {
      price = undefined;
    }
    this.cache.set(feed, { price, at: now });
    return price;
  }
}

/** Asks each source in order and returns the first price found. */
export class FallbackPriceSource implements PriceSource {
  readonly name: string;
  constructor(private readonly sources: readonly PriceSource[]) {
    this.name = sources.map((s) => s.name).join("+");
  }
  async usdPrice(mint: Address) {
    for (const source of this.sources) {
      const price = await source.usdPrice(mint);
      if (price !== undefined) return price;
    }
    return undefined;
  }
}

/**
 * Pyth first when PYTH_API_KEY is set, with keyless Jupiter behind it (so an expired or
 * rate-limited key degrades to Jupiter rather than to "no price"); otherwise Jupiter alone.
 */
export function createPriceSource(
  env: Record<string, string | undefined> = process.env,
): PriceSource {
  const jupiter = new JupiterPriceSource({ apiKey: env.JUPITER_API_KEY });
  if (!env.PYTH_API_KEY) return jupiter;
  return new FallbackPriceSource([new PythPriceSource({ apiKey: env.PYTH_API_KEY }), jupiter]);
}

/** Fixed prices, for tests and offline runs. */
export class StaticPriceSource implements PriceSource {
  readonly name = "static";
  constructor(private readonly prices: Partial<Record<Address, number>>) {}
  async usdPrice(mint: Address) {
    const token = tokenByMint(mint);
    return this.prices[mint] ?? (token ? this.prices[token.mints.mainnet] : undefined);
  }
}
