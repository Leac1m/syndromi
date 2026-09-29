// The server's owner API. The session token lives in memory, mirrored to sessionStorage as a
// per-tab convenience (the page works without it).
import { type Network, SERVER } from "./config";

export type AgentView = {
  name: string;
  address: string;
  cluster: string;
  runtime: "local" | "hosted";
  allowance?: { mint: string; amount: number; period: string };
  feeBudgetSol?: number;
  ruleCard: string[];
  funded: boolean;
  demo?: boolean;
  nextRun?: number | null;
  allowanceLeft?: { remaining: number; limit: number; periodEndsAt?: number };
  topUps: { remaining: number; expiresAt: number }[];
  pending: number;
};

export type Overview = {
  owner: string;
  cluster: Network;
  bag: { usdc: number; sol: number; usdcMint?: string };
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

export type ActivityEvent = { seq: number; agentName: string; type: string; at: string } & Record<
  string,
  unknown
>;

export type Template = {
  name: string;
  manifest: Record<string, unknown> & {
    name: string;
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

async function call<T>(path: string, body?: unknown): Promise<T> {
  const token = currentSession()?.token;
  const res = await fetch(`${SERVER}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
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
  createHosted: (template: string, cluster: Network, manifest: unknown) =>
    call<AgentView>("/owner/agents", { template, cluster, manifest }),
};
