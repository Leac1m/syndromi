// `syndromi faucet`: devnet test USDC for the CLI's owner wallet, from a server's faucet. It
// signs in the way the dashboard does (a signed message, never a transaction) and then claims.
// Needs only the server's address: the owner's signature is the credential, not the admin token.
import { getBase58Decoder, getUtf8Encoder, signBytes } from "@solana/kit";
import { type Cluster, explorerTx } from "@syndromi/core";
import { type Env, loadOwner } from "../context.js";
import { CliError, type Io } from "../io.js";

export async function faucet(opts: { cluster: Cluster; server?: string }, io: Io, env: Env) {
  if (opts.cluster !== "devnet") throw new CliError("test tokens exist on devnet only");
  const base = (opts.server ?? env.SYNDROMI_SERVER_URL)?.replace(/\/+$/, "");
  if (!base) throw new CliError("no server: pass --server <url> or set SYNDROMI_SERVER_URL");
  const owner = await loadOwner(env);

  const post = async <T>(path: string, body: unknown, token?: string): Promise<T> => {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as T & { error?: unknown; nextAt?: string };
    if (!res.ok) {
      const next = json.nextAt ? ` (next claim after ${json.nextAt})` : "";
      throw new CliError(`${String(json.error ?? `HTTP ${res.status}`)}${next}`);
    }
    return json;
  };

  const { nonce, text } = await post<{ nonce: string; text: string }>("/owner/session/challenge", {
    owner: owner.address,
  });
  const signature = getBase58Decoder().decode(
    await signBytes(owner.keyPair.privateKey, getUtf8Encoder().encode(text)),
  );
  const { token } = await post<{ token: string }>("/owner/session", {
    owner: owner.address,
    nonce,
    signature,
  });
  const got = await post<{ amount: number; symbol: string; signature: string }>(
    "/owner/faucet",
    {},
    token,
  );
  io.print(
    `${got.amount} test ${got.symbol} sent to ${owner.address}\n${explorerTx(got.signature, "devnet")}`,
  );
}
