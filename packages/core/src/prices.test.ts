import { describe, expect, it, vi } from "vitest";
import {
  createPriceSource,
  FallbackPriceSource,
  JupiterPriceSource,
  PythPriceSource,
  StaticPriceSource,
} from "./prices.js";
import { findToken } from "./tokens.js";

const USDC = findToken("USDC", "mainnet");
if (!USDC?.mints.devnet) throw new Error("USDC registry entry missing");
const usdcMainnet = USDC.mints.mainnet;
const usdcDevnet = USDC.mints.devnet;

const json = (body: unknown, ok = true) =>
  Promise.resolve({ ok, json: () => Promise.resolve(body) } as Response);

describe("JupiterPriceSource", () => {
  it("returns usdPrice and prices devnet mints as their mainnet twin", async () => {
    const fetch = vi.fn((_url: string | URL | Request, _init?: RequestInit) =>
      json({ [usdcMainnet]: { usdPrice: 0.9999 } }),
    );
    const source = new JupiterPriceSource({ fetch });
    expect(await source.usdPrice(usdcDevnet)).toBe(0.9999);
    expect(String(fetch.mock.calls[0]?.[0])).toContain(`ids=${usdcMainnet}`);
  });

  it("caches for 30s", async () => {
    let now = 0;
    const fetch = vi.fn(() => json({ [usdcMainnet]: { usdPrice: 1 } }));
    const source = new JupiterPriceSource({ fetch, now: () => now });
    await source.usdPrice(usdcMainnet);
    now = 29_000;
    await source.usdPrice(usdcMainnet);
    expect(fetch).toHaveBeenCalledTimes(1);
    now = 31_000;
    await source.usdPrice(usdcMainnet);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("returns undefined on HTTP errors, missing entries, and network failures", async () => {
    expect(
      await new JupiterPriceSource({ fetch: () => json({}, false) }).usdPrice(usdcMainnet),
    ).toBeUndefined();
    expect(
      await new JupiterPriceSource({ fetch: () => json({}) }).usdPrice(usdcMainnet),
    ).toBeUndefined();
    const failing = () => Promise.reject(new Error("offline"));
    expect(await new JupiterPriceSource({ fetch: failing }).usdPrice(usdcMainnet)).toBeUndefined();
  });
});

describe("PythPriceSource", () => {
  const now = 1_800_000_000_000;
  const update = (publishTime: number) =>
    json({ parsed: [{ price: { price: "99990000", expo: -8, publish_time: publishTime } }] });

  it("scales price by expo and sends the bearer key", async () => {
    const fetch = vi.fn((_url: string | URL | Request, _init?: RequestInit) =>
      update(now / 1000 - 5),
    );
    const source = new PythPriceSource({ apiKey: "k", fetch, now: () => now });
    expect(await source.usdPrice(usdcMainnet)).toBeCloseTo(0.9999);
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k");
  });

  it("rejects stale prices and tokens without a feed", async () => {
    const stale = new PythPriceSource({
      apiKey: "k",
      fetch: () => update(now / 1000 - 600),
      now: () => now,
    });
    expect(await stale.usdPrice(usdcMainnet)).toBeUndefined();
    const unknown = new PythPriceSource({ apiKey: "k", fetch: () => update(now / 1000) });
    expect(await unknown.usdPrice("11111111111111111111111111111111" as never)).toBeUndefined();
  });
});

describe("FallbackPriceSource", () => {
  it("returns the first defined price, in order", async () => {
    const a = new StaticPriceSource({});
    const b = new StaticPriceSource({ [usdcMainnet]: 1.01 });
    const c = new StaticPriceSource({ [usdcMainnet]: 2 });
    expect(await new FallbackPriceSource([a, b, c]).usdPrice(usdcMainnet)).toBe(1.01);
    expect(await new FallbackPriceSource([a]).usdPrice(usdcMainnet)).toBeUndefined();
  });

  it("falls through to Jupiter when the Pyth key is rejected, warning once", async () => {
    const warn = vi.fn();
    const pyth = new PythPriceSource({
      apiKey: "expired",
      fetch: () => Promise.resolve({ ok: false, status: 401 } as Response),
      warn,
    });
    const jupiter = new JupiterPriceSource({
      fetch: () => json({ [usdcMainnet]: { usdPrice: 0.9998 } }),
    });
    const source = new FallbackPriceSource([pyth, jupiter]);
    expect(await source.usdPrice(usdcMainnet)).toBe(0.9998);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("HTTP 401");
  });

  it("treats a 403 as a feed missing from the plan, warning once per feed", async () => {
    const warn = vi.fn();
    const pyth = new PythPriceSource({
      apiKey: "k",
      fetch: () => Promise.resolve({ ok: false, status: 403 } as Response),
      warn,
      now: () => 0,
    });
    expect(await pyth.usdPrice(usdcMainnet)).toBeUndefined();
    expect(await pyth.usdPrice(usdcMainnet)).toBeUndefined(); // cached, no second warning
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/not entitled to the USDC feed/);
  });
});

describe("createPriceSource", () => {
  it("puts Pyth in front of Jupiter only when PYTH_API_KEY is set", () => {
    expect(createPriceSource({}).name).toBe("jupiter");
    expect(createPriceSource({ PYTH_API_KEY: "k" }).name).toBe("pyth+jupiter");
  });
});
