// Owner approvals of held drafts. The owner signs a plain-text message (a sign-message Blink)
// naming the draft, its hash, and the most it may move. The server verifies it, and the runtime
// verifies it again before executing, so a compromised server cannot forge an approval.
import {
  type Address,
  getBase58Encoder,
  getPublicKeyFromAddress,
  getUtf8Encoder,
  isSignatureBytes,
  verifySignature,
} from "@solana/kit";
import type { Intent } from "./policy.js";

/** The parts of a draft an approval commits to. */
export type DraftCore = {
  id: string;
  agent: Address;
  tool: string;
  input: unknown;
  intent: Intent;
};

export const APPROVAL_TTL_MS = 30 * 60 * 1000;

/** sha256 over canonical JSON (sorted keys, bigints as strings), hex. */
export async function draftHash(draft: DraftCore): Promise<string> {
  const { id, agent, tool, input, intent } = draft;
  const bytes = getUtf8Encoder().encode(canonicalJson({ id, agent, tool, input, intent }));
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function approvalMessage(args: {
  draft: DraftCore;
  agentName: string;
  summary: string;
  usd: number;
  owner: Address;
  nonce: string;
  issuedAt: Date;
}): Promise<string> {
  return [
    "syndromi approval",
    `Approve draft ${args.draft.id} for agent ${args.agentName} (${args.draft.agent}):`,
    `${args.summary} (at most $${args.usd.toFixed(2)}).`,
    `Draft hash: ${await draftHash(args.draft)}`,
    `Owner: ${args.owner}`,
    `Nonce: ${args.nonce}`,
    `Issued: ${args.issuedAt.toISOString()}`,
  ].join("\n");
}

export type ApprovalCheck =
  | { ok: true; usd: number; nonce: string; issuedAt: Date }
  | { ok: false; reason: string };

/**
 * Checks that `text` approves exactly `draft` for `owner`, is fresh, and that `signature`
 * (base58, as wallets return it) is the owner's ed25519 signature over the text's UTF-8 bytes.
 */
export async function verifyOwnerApproval(args: {
  text: string;
  signature: string;
  owner: Address;
  draft: DraftCore;
  now?: Date;
  ttlMs?: number;
}): Promise<ApprovalCheck> {
  const fail = (reason: string): ApprovalCheck => ({ ok: false, reason });
  const lines = args.text.split("\n");
  const field = (prefix: string) =>
    lines
      .find((l) => l.startsWith(prefix))
      ?.slice(prefix.length)
      .trim();

  if (lines[0] !== "syndromi approval") return fail("not a syndromi approval message");
  if (!lines[1]?.startsWith(`Approve draft ${args.draft.id} for agent `)) {
    return fail("message approves a different draft");
  }
  if (!lines[1].includes(`(${args.draft.agent})`)) return fail("message names a different agent");
  if (field("Draft hash:") !== (await draftHash(args.draft))) {
    return fail("draft hash mismatch: the draft changed after it was approved");
  }
  if (field("Owner:") !== args.owner) return fail("message names a different owner");
  const usdMatch = lines[2]?.match(/\(at most \$(\d+(?:\.\d+)?)\)\.$/);
  if (!usdMatch?.[1]) return fail("message has no USD bound");
  const nonce = field("Nonce:");
  const issued = field("Issued:");
  const issuedAt = issued ? new Date(issued) : undefined;
  if (!nonce || !issuedAt || Number.isNaN(issuedAt.getTime())) return fail("malformed message");
  const now = args.now ?? new Date();
  const age = now.getTime() - issuedAt.getTime();
  if (age > (args.ttlMs ?? APPROVAL_TTL_MS)) return fail("approval expired");
  if (age < -60_000) return fail("approval issued in the future");

  let signature: Uint8Array;
  try {
    signature = new Uint8Array(getBase58Encoder().encode(args.signature));
  } catch {
    return fail("signature is not base58");
  }
  if (!isSignatureBytes(signature)) return fail("signature has the wrong length");
  const key = await getPublicKeyFromAddress(args.owner);
  const valid = await verifySignature(key, signature, getUtf8Encoder().encode(args.text));
  if (!valid) return fail("signature does not match the owner");
  return { ok: true, usd: Number(usdMatch[1]), nonce, issuedAt };
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}
