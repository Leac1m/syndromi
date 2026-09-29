import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBase58Decoder } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  decryptKeypair,
  encryptKeypair,
  generateAgentKeypair,
  hostedKeyVar,
  loadHostedKeypair,
  loadLocalKeypair,
  saveLocalKeypair,
} from "./agent-wallet.js";

const PASS = "correct horse battery";

describe("agent wallet", () => {
  it("round-trips through encryption to the same address", async () => {
    const keypair = await generateAgentKeypair();
    expect(keypair.secretKey).toHaveLength(64);
    const file = await encryptKeypair(keypair, PASS);
    expect(file.ciphertext).not.toContain(Buffer.from(keypair.secretKey).toString("base64"));
    const restored = await decryptKeypair(file, PASS);
    expect(restored.signer.address).toBe(keypair.signer.address);
  });

  it("rejects a wrong passphrase, a tampered ciphertext, and a swapped address", async () => {
    const file = await encryptKeypair(await generateAgentKeypair(), PASS);
    await expect(decryptKeypair(file, "wrong passphrase")).rejects.toThrow(/wrong passphrase/);

    const bytes = Buffer.from(file.ciphertext, "base64");
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    await expect(
      decryptKeypair({ ...file, ciphertext: bytes.toString("base64") }, PASS),
    ).rejects.toThrow(/wrong passphrase or corrupted/);

    const other = await generateAgentKeypair();
    await expect(
      decryptKeypair({ ...file, address: other.signer.address }, PASS),
    ).rejects.toThrow();
  });

  it("refuses short passphrases", async () => {
    await expect(encryptKeypair(await generateAgentKeypair(), "short")).rejects.toThrow(/8/);
  });

  it("saves with owner-only permissions and loads back", async () => {
    const root = await mkdtemp(join(tmpdir(), "syndromi-"));
    const keypair = await generateAgentKeypair();
    const path = await saveLocalKeypair("dca-agent", keypair, PASS, { root });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, "agents", "dca-agent"))).mode & 0o777).toBe(0o700);
    const loaded = await loadLocalKeypair("dca-agent", PASS, { root });
    expect(loaded.signer.address).toBe(keypair.signer.address);
    await expect(saveLocalKeypair("dca-agent", keypair, PASS, { root })).rejects.toThrow();
  });

  it("loads hosted keys from JSON arrays and base58", async () => {
    const keypair = await generateAgentKeypair();
    expect(hostedKeyVar("yield-scout")).toBe("SYNDROMI_AGENT_KEY_YIELD_SCOUT");
    const asJson = { SYNDROMI_AGENT_KEY_YIELD_SCOUT: JSON.stringify([...keypair.secretKey]) };
    expect((await loadHostedKeypair("yield-scout", asJson)).signer.address).toBe(
      keypair.signer.address,
    );
    const asBase58 = {
      SYNDROMI_AGENT_KEY_YIELD_SCOUT: getBase58Decoder().decode(keypair.secretKey),
    };
    expect((await loadHostedKeypair("yield-scout", asBase58)).signer.address).toBe(
      keypair.signer.address,
    );
    await expect(loadHostedKeypair("yield-scout", {})).rejects.toThrow(/not set/);
  });
});
