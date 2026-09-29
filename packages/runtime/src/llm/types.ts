// Provider-agnostic LLM interface. Each conversation keeps its own provider-native transcript
// and echoes assistant messages back verbatim: Gemini 3 carries thought signatures inside
// tool_calls (extra_content), and Anthropic may return thinking blocks, both of which must be
// sent back unchanged.
import type { ToolDescriptor } from "@syndromi/tools";

export type ToolCall = { id: string; name: string; input: unknown };

export type Turn = {
  text?: string;
  toolCalls: ToolCall[];
  stop: "tool_calls" | "end" | "length" | "other";
};

export type ToolResultMessage = { id: string; name: string; content: string };

export interface Conversation {
  /** First call sends the user message; later calls send the results of the last tool calls. */
  send(input: { user: string } | { toolResults: ToolResultMessage[] }): Promise<Turn>;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  start(system: string, tools: ToolDescriptor[]): Conversation;
}

export type Fetch = typeof fetch;

const ATTEMPTS = 4;

/**
 * POST JSON with a timeout, retrying rate limits and transient server errors with backoff
 * (Gemini answers 503 "high demand" in bursts). Honours Retry-After when present.
 */
export async function postJson(
  fetchImpl: Fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  label: string,
): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    if (res.ok) return res.json();
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < ATTEMPTS) {
      const retryAfter = Number(res.headers?.get("retry-after"));
      const delay = retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 1000;
      await new Promise((r) => setTimeout(r, Math.min(delay, 20_000)));
      continue;
    }
    const text = await res.text().catch(() => "");
    throw new Error(`${label} HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
}

export function parseArguments(raw: string | undefined): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw; // invalid JSON reaches the tool's schema check and comes back as an error
  }
}
