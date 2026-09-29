// Solana Actions plumbing: the headers every Actions response needs (spec v2.4), CORS
// preflight, actions.json, errors, and the Blink icon. Types come from @solana/actions-spec
// (types only), so no web3.js v1 is involved.
import type { ActionError } from "@solana/actions-spec";
import type { Cluster } from "@syndromi/core";
import type { Context, Hono } from "hono";

/** CAIP-2 chain ids (genesis-hash based). The fork mirrors mainnet. */
export const BLOCKCHAIN_IDS: Record<Cluster, string> = {
  devnet: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  mainnet: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  fork: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
};

export const ACTIONS_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, Content-Encoding, Accept-Encoding, X-Accept-Action-Version, X-Accept-Blockchain-Ids",
  "Access-Control-Expose-Headers": "X-Action-Version, X-Blockchain-Ids",
};

export function actionHeaders(cluster: Cluster = "devnet") {
  return {
    ...ACTIONS_CORS_HEADERS,
    "X-Action-Version": "2.4",
    "X-Blockchain-Ids": BLOCKCHAIN_IDS[cluster],
  };
}

export function actionJson(c: Context, body: unknown, cluster: Cluster = "devnet", status = 200) {
  return c.json(body as object, status as 200, actionHeaders(cluster));
}

export function actionError(
  c: Context,
  message: string,
  status = 400,
  cluster: Cluster = "devnet",
) {
  const body: ActionError = { message };
  return actionJson(c, body, cluster, status);
}

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
<rect width="256" height="256" rx="48" fill="#111827"/>
<path d="M64 150c0-38 30-68 68-68h28v28h-28c-22 0-40 18-40 40s18 40 40 40h60v28h-60c-38 0-68-30-68-68z" fill="#34d399"/>
<circle cx="176" cy="96" r="20" fill="#fbbf24"/>
</svg>`;

export function mountSpec(app: Hono, publicUrl: string) {
  app.options("/actions/*", (c) => c.body(null, 204, ACTIONS_CORS_HEADERS));
  app.options("/actions.json", (c) => c.body(null, 204, ACTIONS_CORS_HEADERS));
  app.get("/actions.json", (c) =>
    c.json(
      { rules: [{ pathPattern: "/actions/**", apiPath: "/actions/**" }] },
      200,
      ACTIONS_CORS_HEADERS,
    ),
  );
  app.get("/actions/icon.svg", (c) =>
    c.body(ICON, 200, { ...ACTIONS_CORS_HEADERS, "Content-Type": "image/svg+xml" }),
  );
  return `${publicUrl}/actions/icon.svg`;
}

/** The link to share: dial.to renders the Blink and hands signing to the wallet. */
export function blinkUrl(publicUrl: string, path: string) {
  return `https://dial.to/?action=${encodeURIComponent(`solana-action:${publicUrl}${path}`)}`;
}
