// Provider-agnostic LLM interface. Each conversation keeps its own provider-native transcript
// and echoes assistant messages back verbatim: Gemini 3 carries thought signatures inside
// tool_calls (extra_content), and Anthropic may return thinking blocks, both of which must be
// sent back unchanged.
import type { ToolDescriptor } from "@syndromi/tools";

export type ToolCall = { id: string; name: string; input: unknown };

export type Turn = {
  text?: string;
  toolCalls: ToolCall[];
  stop: "tool_calls" | "end" | "length" | "refusal" | "other";
};

export type ToolResultMessage = { id: string; name: string; content: string };

export interface Conversation {
  /** First call sends the user message; later calls send the results of the last tool calls. */
  send(input: { user: string } | { toolResults: ToolResultMessage[] }): Promise<Turn>;
}

/** Something the run's activity log should show, e.g. a switch to the backup model. */
export type LlmNotice = { type: "llm_failover"; from: string; to: string; reason: string };

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  start(
    system: string,
    tools: ToolDescriptor[],
    notify?: (notice: LlmNotice) => void | Promise<void>,
  ): Conversation;
}

export type Fetch = typeof fetch;

const ATTEMPTS = 4;
const TIMEOUT_MS = 60_000;
const TIMEOUT_TRIES = 2;

/**
 * POST JSON with a timeout, retrying rate limits and transient server errors with backoff
 * (Gemini answers 503 "high demand" in bursts) and a timeout or unreachable host once. Honours
 * Retry-After when present. Errors name the provider and model (`label`).
 */
export async function postJson(
  fetchImpl: Fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  label: string,
): Promise<unknown> {
  let networkFailures = 0;
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      networkFailures++;
      const timedOut = (error as Error).name === "TimeoutError";
      if (networkFailures < TIMEOUT_TRIES) continue;
      if (timedOut) {
        throw new Error(
          `${label} did not respond within ${TIMEOUT_MS / 1000} s (${TIMEOUT_TRIES} tries)`,
        );
      }
      const cause = (error as Error & { cause?: Error }).cause?.message;
      throw new Error(
        `${label}: cannot reach ${new URL(url).host} (${TIMEOUT_TRIES} tries): ${cause ?? (error as Error).message}`,
      );
    }
    if (res.ok) return res.json();
    const text = await res.text().catch(() => "");
    // A daily quota (e.g. Gemini's free tier, 20 requests/day/model) will not recover in seconds.
    const daily = res.status === 429 && /PerDay/.test(text);
    const retryable = !daily && (res.status === 429 || res.status >= 500);
    if (retryable && attempt < ATTEMPTS) {
      const retryAfter = Number(res.headers?.get("retry-after"));
      const delay = retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 1000;
      await new Promise((r) => setTimeout(r, Math.min(delay, 20_000)));
      continue;
    }
    if (daily) {
      throw new Error(
        `${label}: daily request quota exhausted; try another model (run --model <id>)`,
      );
    }
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
