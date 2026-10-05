import { afterEach, describe, expect, it, vi } from "vitest";
import { api, pingServer, ServerUnreachable } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("reaching the server", () => {
  it("reports no answer as ServerUnreachable, not as a fetch error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    await expect(api.overview("devnet")).rejects.toBeInstanceOf(ServerUnreachable);
  });

  it("still reports the server's own errors as they are", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "sign in first" }, { status: 401 })),
    );
    await expect(api.overview("devnet")).rejects.toThrow("sign in first");
  });

  it("pingServer is true only for a healthy answer and never throws", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toMatch(/\/healthz$/);
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await pingServer()).toBe(true);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ok: false }, { status: 503 })),
    );
    expect(await pingServer()).toBe(false);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    expect(await pingServer()).toBe(false);
  });
});
