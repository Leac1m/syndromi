// The server's owner API. The session token lives in memory, mirrored to sessionStorage as a
// per-tab convenience (the page works without it).
import { type Network, SERVER } from "./config";

export type AgentView = {
  name: string;
  address: string;
  cluster: string;
  runtime: "local" | "hosted" | "external";
  /** `server`: the key is held by the server and the owner's AI connects with a token. */
  custody?: "server" | "local";
  allowance?: { mint: string; amount: number; period: string };
  feeBudgetSol?: number;
  ruleCard: string[];
  funded: boolean;
  demo?: boolean;
  /** Paused by the owner: it does not run or act until resumed. */
  paused?: boolean;
  /** Whether the server holds its key and so can pause it. */
  pausable?: boolean;
  /** A scripted agent's script, e.g. "tour" for the guided tour. */
  script?: string;
  nextRun?: number | null;
  allowanceLeft?: { remaining: number; limit: number; periodEndsAt?: number };
  topUps: { remaining: number; expiresAt: number }[];
  pending: number;
};

export type Overview = {
  owner: string;
  cluster: Network;
  bag: { usdc: number; sol: number; usdcMint?: string; symbol: string };
  /** Devnet, when the server runs the test-token faucet: what a claim gives and when the next is due. */
  faucet?: { amount: number; nextAt: string | null };
  allocatedPerPeriod: Record<string, number>;
  agents: AgentView[];
  pending: {
    drafts: {
      id: string;
      agentName: string;
      summary: string;
      usd: number;
      expiresAt: string;
      reasons: string[];
    }[];
    topups: { id: string; agentName: string; amount: number; reason: string; expiresAt: string }[];
  };
};

export type TokenView = {
  id: string;
  prefix: string;
  label: string;
  createdAt: string;
  lastUsedAt?: string;
  expiresAt: string;
  revokedAt?: string;
};

export const TOKEN_DAYS = [1, 7, 30, 90] as const;

export type ActivityEvent = { seq: number; agentName: string; type: string; at: string } & Record<
  string,
  unknown
>;

export type Template = {
  name: string;
  manifest: Record<string, unknown> & {
    name: string;
    runtime: "local" | "hosted" | "external";
    allowance: { mint: string; amount: number; period: string };
    permissions: {
      programs: string[];
      destinations: string[];
      max_tx_usd: number;
      approve_above_usd: number;
    };
    fee_budget: { sol: number };
  };
  prompt: string;
  ruleCard: string[];
};

/** A template that runs a built-in script instead of a model (`model: script:<name>`). */
export const isScripted = (t: Template) => String(t.manifest.model ?? "").startsWith("script:");

/** The guided tour's template, and the name one owner's tour agent gets (names are per server). */
export const TOUR_TEMPLATE = "guided-tour";
export const tourAgentName = (owner: string) => `tour-${owner.slice(0, 8).toLowerCase()}`;

const KEY = "syndromi.session";
let session: { token: string; owner: string } | undefined;

export function currentSession() {
  if (session) return session;
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw) session = JSON.parse(raw) as { token: string; owner: string };
  } catch {
    // storage unavailable: sign in again
  }
  return session;
}

export function clearSession() {
  session = undefined;
  try {
    sessionStorage.removeItem(KEY);
  } catch {}
}

/** The server did not answer at all (restarting, or the network is down): not an HTTP error. */
export class ServerUnreachable extends Error {
  constructor() {
    super("The server is not answering. It may be restarting; this page keeps trying.");
    this.name = "ServerUnreachable";
  }
}

const CALL_TIMEOUT_MS = 30_000;
const PING_TIMEOUT_MS = 5_000;

/** fetch that turns "no answer" (network error or timeout) into ServerUnreachable. */
async function reach(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  try {
    return await fetch(`${SERVER}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new ServerUnreachable();
  }
}

/** Whether the server is up and its store answers (GET /healthz). Never throws. */
export async function pingServer(): Promise<boolean> {
  try {
    const res = await reach("/healthz", {}, PING_TIMEOUT_MS);
    return res.ok;
  } catch {
    return false;
  }
}

async function call<T>(path: string, body?: unknown, method?: "DELETE"): Promise<T> {
  const token = currentSession()?.token;
  const res = await reach(
    path,
    {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    CALL_TIMEOUT_MS,
  );
  const json = (await res.json().catch(() => ({}))) as T & { error?: unknown };
  if (res.status === 401 && path !== "/owner/session") clearSession();
  if (!res.ok) {
    const error = Array.isArray(json.error)
      ? json.error.join("; ")
      : String(json.error ?? `HTTP ${res.status}`);
    throw new Error(error);
  }
  return json;
}

export async function signIn(owner: string, signMessage: (text: string) => Promise<string>) {
  const { nonce, text } = await call<{ nonce: string; text: string }>("/owner/session/challenge", {
    owner,
  });
  const signature = await signMessage(text);
  const result = await call<{ token: string; owner: string }>("/owner/session", {
    owner,
    nonce,
    signature,
  });
  session = { token: result.token, owner: result.owner };
  try {
    sessionStorage.setItem(KEY, JSON.stringify(session));
  } catch {}
  return session;
}

export const api = {
  overview: (cluster: Network) => call<Overview>(`/owner/overview?cluster=${cluster}`),
  activity: (after?: number, agent?: string) =>
    call<{ events: ActivityEvent[] }>(
      `/owner/activity?${new URLSearchParams({
        ...(after !== undefined ? { after: String(after) } : {}),
        ...(agent ? { agent } : {}),
      })}`,
    ),
  templates: () => call<Template[]>("/owner/templates"),
  preview: (manifest: unknown, runtime: string) =>
    call<{ ok: boolean; errors?: string[]; ruleCard?: string[] }>("/owner/preview", {
      manifest,
      runtime,
    }),
  runNow: (name: string) =>
    call<{ started: boolean }>(`/owner/agents/${encodeURIComponent(name)}/run`, {}),
  setPaused: (name: string, paused: boolean) =>
    call<AgentView>(`/owner/agents/${encodeURIComponent(name)}/${paused ? "pause" : "resume"}`, {}),
  removeAgent: (name: string) =>
    call<{ removed: string }>(`/owner/agents/${encodeURIComponent(name)}`, undefined, "DELETE"),
  createHosted: (template: string, cluster: Network, manifest: unknown, custody?: "server") =>
    call<AgentView>("/owner/agents", {
      template,
      cluster,
      manifest,
      ...(custody ? { custody } : {}),
    }),
  tokens: (agent: string) =>
    call<{ tokens: TokenView[] }>(`/owner/agents/${encodeURIComponent(agent)}/tokens`),
  createToken: (agent: string, days: number, label: string) =>
    call<TokenView & { token: string }>(`/owner/agents/${encodeURIComponent(agent)}/tokens`, {
      days,
      label,
    }),
  revokeToken: (agent: string, id: string) =>
    call<{ revoked: string }>(
      `/owner/agents/${encodeURIComponent(agent)}/tokens/${encodeURIComponent(id)}`,
      undefined,
      "DELETE",
    ),
  faucet: () => call<{ amount: number; symbol: string; signature: string }>("/owner/faucet", {}),
  telegram: () => call<{ enabled: boolean; chats: number }>("/owner/telegram"),
  telegramLink: () => call<{ url: string; expiresAt: string }>("/owner/telegram/link", {}),
  telegramDisconnect: () => call<{ unlinked: number }>("/owner/telegram", undefined, "DELETE"),
};
