// Agent keypairs. Local agents keep an encrypted keypair under ~/.syndromi; hosted agents read
// theirs from the environment (managed custody is roadmap).
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  getAddressEncoder,
  getBase58Encoder,
  type KeyPairSigner,
} from "@solana/kit";

export type AgentKeypair = {
  signer: KeyPairSigner;
  /** 64 bytes, Solana CLI layout: 32-byte seed followed by the 32-byte public key. */
  secretKey: Uint8Array;
};

export type EncryptedKeypair = {
  version: 1;
  address: string;
  kdf: { name: "scrypt"; N: number; r: number; p: number; salt: string };
  cipher: { name: "aes-256-gcm"; iv: string; tag: string };
  ciphertext: string;
};

const KDF = { N: 2 ** 17, r: 8, p: 1 };
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const unb64 = (text: string) => new Uint8Array(Buffer.from(text, "base64"));

export async function generateAgentKeypair(): Promise<AgentKeypair> {
  const seed = new Uint8Array(randomBytes(32));
  const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
  const secretKey = new Uint8Array(64);
  secretKey.set(seed, 0);
  secretKey.set(getAddressEncoder().encode(signer.address), 32);
  return { signer, secretKey };
}

function deriveKey(passphrase: string, salt: Uint8Array, kdf = KDF): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(passphrase, salt, 32, { ...kdf, maxmem: 256 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

export async function encryptKeypair(
  keypair: AgentKeypair,
  passphrase: string,
): Promise<EncryptedKeypair> {
  if (passphrase.length < 8) throw new Error("passphrase must be at least 8 characters");
  const salt = new Uint8Array(randomBytes(16));
  const iv = new Uint8Array(randomBytes(12));
  const key = await deriveKey(passphrase, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  // The address is authenticated data: swapping it in the file breaks decryption.
  cipher.setAAD(Buffer.from(keypair.signer.address));
  const ciphertext = Buffer.concat([cipher.update(keypair.secretKey), cipher.final()]);
  return {
    version: 1,
    address: keypair.signer.address,
    kdf: { name: "scrypt", ...KDF, salt: b64(salt) },
    cipher: { name: "aes-256-gcm", iv: b64(iv), tag: b64(cipher.getAuthTag()) },
    ciphertext: b64(ciphertext),
  };
}

export async function decryptKeypair(
  file: EncryptedKeypair,
  passphrase: string,
): Promise<AgentKeypair> {
  if (file.version !== 1) throw new Error(`unsupported keypair file version ${file.version}`);
  const { N, r, p, salt } = file.kdf;
  const key = await deriveKey(passphrase, unb64(salt), { N, r, p });
  const decipher = createDecipheriv("aes-256-gcm", key, unb64(file.cipher.iv));
  decipher.setAAD(Buffer.from(file.address));
  decipher.setAuthTag(Buffer.from(unb64(file.cipher.tag)));
  let secretKey: Uint8Array;
  try {
    secretKey = new Uint8Array(
      Buffer.concat([decipher.update(unb64(file.ciphertext)), decipher.final()]),
    );
  } catch {
    throw new Error("could not decrypt keypair: wrong passphrase or corrupted file");
  }
  const signer = await createKeyPairSignerFromBytes(secretKey);
  if (signer.address !== file.address) throw new Error("decrypted key does not match address");
  return { signer, secretKey };
}

export function syndromiHome(root?: string): string {
  return root ?? process.env.SYNDROMI_HOME ?? join(homedir(), ".syndromi");
}

/** Per-agent state: keypair.enc.json, agent.json, activity.jsonl, drafts/, topups/. */
export const agentDir = (name: string, root?: string) => join(syndromiHome(root), "agents", name);

const keypairPath = (name: string, root?: string) => join(agentDir(name, root), "keypair.enc.json");

/** Writes the encrypted keypair with owner-only permissions (dir 0700, file 0600). */
export async function saveLocalKeypair(
  name: string,
  keypair: AgentKeypair,
  passphrase: string,
  opts: { root?: string } = {},
): Promise<string> {
  const path = keypairPath(name, opts.root);
  await mkdir(agentDir(name, opts.root), { recursive: true, mode: 0o700 });
  const file = await encryptKeypair(keypair, passphrase);
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return path;
}

export async function loadLocalKeypair(
  name: string,
  passphrase: string,
  opts: { root?: string } = {},
): Promise<AgentKeypair> {
  const file = JSON.parse(await readFile(keypairPath(name, opts.root), "utf8")) as EncryptedKeypair;
  return decryptKeypair(file, passphrase);
}

export const hostedKeyVar = (name: string) =>
  `SYNDROMI_AGENT_KEY_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;

/** Hosted agents: SYNDROMI_AGENT_KEY_<NAME> holds a JSON byte array or a base58 secret key. */
export async function loadHostedKeypair(
  name: string,
  env: Record<string, string | undefined> = process.env,
): Promise<AgentKeypair> {
  const variable = hostedKeyVar(name);
  const raw = env[variable]?.trim();
  if (!raw) throw new Error(`${variable} is not set`);
  const bytes = raw.startsWith("[")
    ? new Uint8Array(JSON.parse(raw) as number[])
    : new Uint8Array(getBase58Encoder().encode(raw));
  if (bytes.length !== 64)
    throw new Error(`${variable} must decode to 64 bytes, got ${bytes.length}`);
  return { signer: await createKeyPairSignerFromBytes(bytes), secretKey: bytes };
}
