// Owner sign-in for the dashboard: sign a one-time message with the bag owner's wallet, get a
// session token scoped to that address.
import {
  type Address,
  getBase58Encoder,
  getPublicKeyFromAddress,
  getUtf8Encoder,
  isAddress,
  isSignatureBytes,
  verifySignature,
} from "@solana/kit";
import type { Store } from "./db.js";

export const LOGIN_TTL_MS = 5 * 60 * 1000;
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export function loginMessage(owner: string, nonce: string, issuedAt: Date) {
  return [
    "syndromi dashboard sign-in",
    "Sign in to manage your agents. This costs nothing and sends no transaction.",
    `Owner: ${owner}`,
    `Nonce: ${nonce}`,
    `Issued: ${issuedAt.toISOString()}`,
  ].join("\n");
}

export async function challenge(store: Store, owner: string) {
  if (!isAddress(owner)) throw new Error("not a Solana address");
  const nonce = crypto.randomUUID();
  const text = loginMessage(owner, nonce, new Date());
  await store.issueLoginNonce(nonce, owner, text);
  return { nonce, text };
}

export async function signIn(
  store: Store,
  args: { owner: string; nonce: string; signature: string },
  now = new Date(),
): Promise<{ token: string; owner: string; expiresAt: string }> {
  const text = await store.consumeLoginNonce(args.nonce, args.owner);
  if (!text) throw new Error("unknown or used sign-in request");
  const issued = Date.parse(
    text
      .split("\n")
      .find((l) => l.startsWith("Issued: "))
      ?.slice(8) ?? "",
  );
  if (!(now.getTime() - issued <= LOGIN_TTL_MS)) throw new Error("sign-in request expired");
  let signature: Uint8Array;
  try {
    signature = new Uint8Array(getBase58Encoder().encode(args.signature));
  } catch {
    throw new Error("signature is not base58");
  }
  if (!isSignatureBytes(signature)) throw new Error("signature has the wrong length");
  const key = await getPublicKeyFromAddress(args.owner as Address);
  if (!(await verifySignature(key, signature, getUtf8Encoder().encode(text)))) {
    throw new Error("signature does not match the address");
  }
  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  await store.createSession(token, args.owner, expiresAt);
  return { token, owner: args.owner, expiresAt };
}
