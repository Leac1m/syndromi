import { EventEmitter } from "node:events";
import {
  type Address,
  createClient,
  createNoopSigner,
  createSolanaRpc,
  type KeyPairSigner,
} from "@solana/kit";
import { solanaRpc } from "@solana/kit-plugin-rpc";
import { signer } from "@solana/kit-plugin-signer";
import { subscriptionsProgram } from "@solana/subscriptions";
import { type BagClient, type Cluster, rpcUrlFor } from "@syndromi/core";
import type { AgentLimits } from "./agent-api.js";
import type { DraftRecord, Store, TopUpRecord } from "./db.js";
import type { RemoteAgent, Via } from "./hosted.js";
import type { Telegram } from "./telegram.js";

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
  /** Agent API limits (defaults in agent-api.ts); tests lower them. */
  agentLimits?: Partial<AgentLimits>;
};

export type ServerContext = {
  store: Store;
  /** The in-process hosted runtime, when SYNDROMI_HOSTED_SECRET is set (see hosted.ts). */
  hosted?: {
    scan(): void;
    runNow(name: string): boolean;
    nextRun?(name: string): Date | null;
    unload?(name: string): void;
    /** The tool context for a server-held external agent (see HostedRuntime.remote). */
    remote?(name: string, via: Via): Promise<RemoteAgent | undefined>;
  };
  /** The Telegram bot, when TELEGRAM_BOT_TOKEN is set. */
  telegram?: Telegram;
  /** The beta treasury (devnet mint authority), when SYNDROMI_TREASURY_KEY is set (beta/treasury.ts). */
  treasury?: KeyPairSigner;
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
