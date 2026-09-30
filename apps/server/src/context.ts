import { EventEmitter } from "node:events";
import { type Address, createClient, createNoopSigner, createSolanaRpc } from "@solana/kit";
import { solanaRpc } from "@solana/kit-plugin-rpc";
import { signer } from "@solana/kit-plugin-signer";
import { subscriptionsProgram } from "@solana/subscriptions";
import { type BagClient, type Cluster, rpcUrlFor } from "@syndromi/core";
import type { DraftRecord, Store, TopUpRecord } from "./db.js";

export type ServerEvents = {
  draft: [DraftRecord];
  topup: [TopUpRecord];
  activity: [string, Record<string, unknown>];
};

export class Bus extends EventEmitter<ServerEvents> {}

export type ServerConfig = {
  /** Base URL wallets and dial.to use to reach the Actions endpoints. */
  publicUrl: string;
  /** Bearer token the runtime uses for /api. */
  token: string;
  env: Record<string, string | undefined>;
  draftTtlMs: number;
  topUpTtlMs: number;
  /** Origins allowed to call /owner (the dashboard). */
  dashboardOrigins: string[];
};

export type ServerContext = {
  store: Store;
  /** The in-process hosted runtime, when SYNDROMI_HOSTED_SECRET is set (see hosted.ts). */
  hosted?: {
    scan(): void;
    runNow(name: string): boolean;
    nextRun?(name: string): Date | null;
    unload?(name: string): void;
  };
  /** What happens after each kind of owner transaction lands (see owner-tx.ts). */
  completions: Map<string, (tx: never, signature: string | undefined) => Promise<unknown>>;
  bus: Bus;
  config: ServerConfig;
  rpc(cluster: Cluster): ReturnType<typeof createSolanaRpc>;
  /** A subscriptions client acting for `owner` with a noop signer (builds, never signs). */
  ownerClient(cluster: Cluster, owner: Address): BagClient;
};

export function createContext(store: Store, config: ServerConfig): ServerContext {
  const rpcs = new Map<Cluster, ReturnType<typeof createSolanaRpc>>();
  return {
    store,
    completions: new Map(),
    bus: new Bus(),
    config,
    rpc(cluster) {
      let rpc = rpcs.get(cluster);
      if (!rpc) {
        rpc = createSolanaRpc(rpcUrlFor(cluster, config.env));
        rpcs.set(cluster, rpc);
      }
      return rpc;
    },
    ownerClient(cluster, owner) {
      return createClient()
        .use(signer(createNoopSigner(owner)))
        .use(solanaRpc({ rpcUrl: rpcUrlFor(cluster, config.env) }))
        .use(subscriptionsProgram());
    },
  };
}

export const newId = (prefix: "d" | "t") => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
