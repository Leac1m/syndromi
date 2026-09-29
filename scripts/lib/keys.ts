import { homedir } from "node:os";
import { join } from "node:path";

/** The owner (bag) wallet for spikes: the Solana CLI keypair. Override with OWNER_KEYPAIR. */
export function ownerKeypairPath(): string {
  return process.env.OWNER_KEYPAIR ?? join(homedir(), ".config", "solana", "id.json");
}
