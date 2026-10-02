// The hosted runtime: the same agent loop as `syndromi run`, inside the server. Each hosted agent
// runs on its manifest schedule (and on "Run now"), with its key decrypted from the store using
// SYNDROMI_HOSTED_SECRET. Drafts, top-up requests and activity go straight into the store (so
// Telegram and the dashboard see them), and an approval watcher executes what the owner signed.
import {
  decryptKeypair,
  type EncryptedKeypair,
  type Manifest,
  manifestSchema,
  ruleCard,
  sendAndConfirm,
} from "@syndromi/core";
import {
  ActivityLog,
  type ActivitySink,
  type ApprovalGateway,
  createProvider,
  executeApprovals,
  type LlmProvider,
  type PreparedAgent,
  prepareAgent,
  runOnce,
  schedule,
  type ToolCallOptions,
} from "@syndromi/runtime";
import { createToolset, type Toolset } from "@syndromi/tools";
import type { ServerContext } from "./context.js";
import type { AgentRecord } from "./db.js";
import {
  approvalsFor,
  createDraft,
  createTopUp,
  recordActivity,
  reportDraft,
  reportTopUp,
} from "./records.js";

const WATCH_EVERY_MS = 5_000;
const RESCAN_EVERY_MS = 30_000;

type Loaded = {
  record: AgentRecord;
  manifest: Manifest;
  prompt: string;
  agent: PreparedAgent;
  tools: Toolset;
  /** Absent for server-held external agents: their brain is the owner's own AI. */
  provider?: LlmProvider;
  running: boolean;
  watching: boolean;
  attempts: Map<string, number>;
  job?: { stop(): void; next(): Date | null };
};

/** How a call reached an agent, recorded on its activity events. */
export type Via = { via: "mcp-http" | "http"; token: string };

/** What a token-holder's AI needs to act as a server-held agent. */
export type RemoteAgent = {
  call: ToolCallOptions;
  manifest: Manifest;
  rules: string[];
  guidance: string;
};

export type HostedOptions = {
  /** Run agents on their manifest cron (off: only "Run now"). */
  schedule: boolean;
  /** Tests inject a provider (e.g. scripted); by default the manifest's own. */
  providerFor?: (manifest: Manifest) => LlmProvider;
  log?: (line: string) => void;
};

export class HostedRuntime {
  private readonly agents = new Map<string, Loaded>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private scanning: Promise<void> | undefined;

  constructor(
    private readonly ctx: ServerContext,
    private readonly opts: HostedOptions,
  ) {}

  start() {
    this.scan();
    this.timers.push(setInterval(() => this.scan(), RESCAN_EVERY_MS));
    this.timers.push(setInterval(() => void this.watchAll(), WATCH_EVERY_MS));
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const a of this.agents.values()) a.job?.stop();
  }

  /** Load hosted agents that are not running yet (new ones from the wizard or `deploy`). */
  scan() {
    this.scanning ??= this.loadNew().finally(() => {
      this.scanning = undefined;
    });
  }

  /** Resolves when the current scan (if any) has finished. */
  async ready() {
    await this.scanning;
  }

  /** Start a run now; false if the agent is not loaded (yet). */
  runNow(name: string): boolean {
    const loaded = this.agents.get(name);
    if (!loaded) {
      this.scan();
      return false;
    }
    void this.run(loaded);
    return true;
  }

  /** Run now and wait for it (tests, CLI-like callers). */
  async runAndWait(name: string) {
    await this.ready();
    const loaded = this.agents.get(name);
    if (!loaded) throw new Error(`hosted agent ${name} is not loaded`);
    await this.run(loaded);
  }

  /** Stop scheduling a removed agent. A run already in flight finishes. */
  unload(name: string) {
    this.agents.get(name)?.job?.stop();
    this.agents.delete(name);
  }

  nextRun(name: string): Date | null {
    return this.agents.get(name)?.job?.next() ?? null;
  }

  private async loadNew() {
    let records: AgentRecord[];
    try {
      records = await this.ctx.store.agents();
    } catch (e) {
      this.opts.log?.(`hosted: could not read agents: ${(e as Error).message}`);
      return;
    }
    for (const record of records) {
      if (!this.isRunnable(record) || this.agents.has(record.name)) continue;
      try {
        this.agents.set(record.name, await this.load(record));
        this.opts.log?.(`hosted: ${record.name} on ${record.cluster} loaded`);
      } catch (e) {
        this.opts.log?.(`hosted: ${record.name} not loaded: ${(e as Error).message}`);
      }
    }
  }

  /** Hosted agents run their own loop; server-held external agents only need the watcher. */
  private isRunnable(record: AgentRecord) {
    if (!record.manifest) return false;
    return (
      record.runtime === "hosted" || (record.runtime === "external" && record.custody === "server")
    );
  }

  private async load(record: AgentRecord): Promise<Loaded> {
    const secret = this.ctx.config.env.SYNDROMI_HOSTED_SECRET ?? "";
    const encrypted = (await this.ctx.store.hostedKey(record.name)) as EncryptedKeypair | undefined;
    if (!encrypted) throw new Error("no key stored");
    const { signer } = await decryptKeypair(encrypted, secret);
    if (signer.address !== record.address) throw new Error("stored key does not match the agent");
    const manifest = manifestSchema.parse(record.manifest);
    const agent = prepareAgent({
      manifest,
      cluster: record.cluster,
      agentSigner: signer,
      owner: record.owner,
      env: this.ctx.config.env,
    });
    const loaded: Loaded = {
      record,
      manifest,
      prompt: record.prompt ?? "",
      agent,
      tools: createToolset(manifest.tools),
      ...(record.runtime === "hosted"
        ? {
            provider:
              this.opts.providerFor?.(manifest) ?? createProvider(manifest, this.ctx.config.env),
          }
        : {}),
      running: false,
      watching: false,
      attempts: new Map(),
    };
    if (record.runtime === "hosted" && this.opts.schedule && manifest.schedule) {
      loaded.job = schedule(manifest.schedule, () => this.run(loaded), {
        onError: (e) =>
          this.opts.log?.(`hosted: ${record.name} run failed: ${(e as Error).message}`),
      });
    }
    return loaded;
  }

  private sink(name: string, via?: Via): ActivitySink {
    return (event) => recordActivity(this.ctx, name, [via ? { ...event, ...via } : event]);
  }

  /**
   * The tool context for a token-holder's AI acting as `name`, or undefined if the agent is not
   * loaded (not found, wrong kind, or its key can't be read). Every call made with it still goes
   * through the agent's policy signer; activity is marked with how the call arrived.
   */
  async remote(name: string, via: Via): Promise<RemoteAgent | undefined> {
    if (!this.agents.has(name)) {
      this.scan();
      await this.ready();
    }
    const a = this.agents.get(name);
    if (!a || a.record.runtime !== "external") return undefined;
    return {
      manifest: a.manifest,
      rules: ruleCard(a.manifest),
      guidance: a.prompt,
      call: {
        tools: a.tools,
        signer: a.agent.signer,
        ctx: a.agent.ctx,
        log: new ActivityLog(name, [this.sink(name, via)]),
        approvals: this.gateway(name),
        send: (tx) => sendAndConfirm(a.agent.rpc, tx),
      },
    };
  }

  private gateway(name: string): ApprovalGateway {
    const ctx = this.ctx;
    return {
      async submitDraft(draft) {
        const saved = await createDraft(ctx, { agentName: name, ...draft });
        return { ...draft, id: saved.id, createdAt: saved.createdAt, status: "pending" };
      },
      async requestTopUp(request) {
        const saved = await createTopUp(ctx, { agentName: name, ...request });
        return { ...request, id: saved.id, createdAt: saved.createdAt, status: "pending" };
      },
    };
  }

  private async run(a: Loaded) {
    if (a.running || !a.provider) return;
    a.running = true;
    try {
      await runOnce({
        manifest: a.manifest,
        prompt: a.prompt,
        provider: a.provider,
        tools: a.tools,
        signer: a.agent.signer,
        ctx: a.agent.ctx,
        log: new ActivityLog(a.record.name, [this.sink(a.record.name)]),
        approvals: this.gateway(a.record.name),
        send: (tx) => sendAndConfirm(a.agent.rpc, tx),
      });
    } finally {
      a.running = false;
    }
  }

  /** Execute owner-approved drafts and top-ups for every hosted agent. */
  async watchAll() {
    await Promise.all([...this.agents.values()].map((a) => this.watch(a)));
  }

  private async watch(a: Loaded) {
    if (a.watching) return;
    a.watching = true;
    const ctx = this.ctx;
    try {
      await executeApprovals({
        client: {
          approvals: async (name) => approvalsFor(ctx, name),
          reportDraft: async (id, result) => reportDraft(ctx, id, result),
          reportTopUp: async (id, result) => reportTopUp(ctx, id, result),
        },
        agentName: a.record.name,
        tools: a.tools,
        signer: a.agent.signer,
        ctx: a.agent.ctx,
        log: new ActivityLog(a.record.name, [this.sink(a.record.name)]),
        send: (tx) => sendAndConfirm(a.agent.rpc, tx),
        attempts: a.attempts,
      });
    } catch (e) {
      this.opts.log?.(`hosted: ${a.record.name} watcher: ${(e as Error).message}`);
    } finally {
      a.watching = false;
    }
  }
}
