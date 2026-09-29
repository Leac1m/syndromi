// A small Blink client over our Solana Actions: one call signs one step. The wallet only signs;
// transactions go back to the server (/actions/tx/:id/submit), which sends them to the right
// cluster. Standard Blink clients can use the same endpoints and send themselves.
import {
  getBase58Decoder,
  getBase64Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getTransactionDecoder,
  type Transaction,
} from "@solana/kit";

export type Card = {
  type?: "action" | "completed";
  icon?: string;
  title: string;
  description: string;
  label: string;
  disabled?: boolean;
  links?: { actions?: { type?: string; href: string; label: string }[] };
};

export type Signer = {
  account: string;
  /** Returns the signature bytes. */
  signMessage(text: string): Promise<Uint8Array>;
  /** Returns the signed transaction's wire bytes. */
  signTransaction(transaction: Transaction): Promise<Uint8Array>;
};

type Fetch = typeof fetch;

export async function getCard(base: string, path: string, fetchImpl: Fetch = fetch): Promise<Card> {
  return request(fetchImpl, `${base}${path}`);
}

/**
 * Runs the first button of `card`: POST the account, sign what comes back, hand it to the server,
 * and return the next card (a chained step, or `type: "completed"`).
 */
export async function runStep(
  base: string,
  card: Card,
  signer: Signer,
  fetchImpl: Fetch = fetch,
): Promise<Card> {
  const href = card.links?.actions?.[0]?.href;
  if (!href) throw new Error("This action has no button.");
  const response = await request<{
    type: string;
    data?: string;
    state?: string;
    transaction?: string;
    links?: { next?: { href: string } };
  }>(fetchImpl, `${base}${href}`, { account: signer.account });
  const next = response.links?.next?.href;
  if (!next) throw new Error("The action returned no follow-up link.");

  if (response.type === "message" && typeof response.data === "string") {
    const signature = getBase58Decoder().decode(await signer.signMessage(response.data));
    return request(fetchImpl, `${base}${next}`, {
      account: signer.account,
      signature,
      data: response.data,
      state: response.state,
    });
  }
  if (response.type === "transaction" && typeof response.transaction === "string") {
    const transaction = getTransactionDecoder().decode(
      getBase64Encoder().encode(response.transaction),
    );
    const signed = await signer.signTransaction(transaction);
    return request(fetchImpl, `${base}${next.replace(/\/confirm$/, "/submit")}`, {
      account: signer.account,
      transaction: getBase64Decoder().decode(signed),
    });
  }
  throw new Error(`Unsupported action response: ${response.type}`);
}

async function request<T = Card>(fetchImpl: Fetch, url: string, body?: unknown): Promise<T> {
  const res = await fetchImpl(url, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await res.json().catch(() => ({}))) as T & { message?: string };
  if (!res.ok) throw new Error(json.message ?? `HTTP ${res.status}`);
  return json;
}
