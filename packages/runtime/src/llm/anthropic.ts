// Anthropic Messages API, bring-your-own-key, through the official SDK. Opus 5.5 always thinks;
// its thinking blocks come back in `content` and are echoed verbatim on the next request.
// `fallbacks: "default"` lets the API re-run a policy-declined request on Anthropic's recommended
// fallback model inside the same call; a refusal that survives it ends the run.
import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaContentBlock,
  BetaMessageParam,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { ToolDescriptor } from "@syndromi/tools";
import type { Conversation, Fetch, LlmProvider, Turn } from "./types.js";

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";
const TIMEOUT_MS = 120_000;
const MAX_RETRIES = 2; // the SDK retries 408/409/429/5xx and connection errors with backoff

export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  private readonly client: Anthropic;

  constructor(
    private readonly opts: {
      apiKey: string;
      model?: string;
      baseUrl?: string;
      fetch?: Fetch;
      maxTokens?: number;
    },
  ) {
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      timeout: TIMEOUT_MS,
      maxRetries: MAX_RETRIES,
      ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
  }

  get model() {
    return this.opts.model ?? DEFAULT_ANTHROPIC_MODEL;
  }

  start(system: string, tools: ToolDescriptor[]): Conversation {
    const messages: BetaMessageParam[] = [];
    const toolSpecs = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
    }));
    const label = `Anthropic ${this.model}`;

    return {
      send: async (input): Promise<Turn> => {
        messages.push(
          "user" in input
            ? { role: "user", content: input.user }
            : {
                role: "user",
                content: input.toolResults.map((r) => ({
                  type: "tool_result" as const,
                  tool_use_id: r.id,
                  content: r.content,
                })),
              },
        );
        let response: Anthropic.Beta.BetaMessage;
        try {
          response = await this.client.beta.messages.create({
            model: this.model,
            max_tokens: this.opts.maxTokens ?? 16_000,
            system,
            messages,
            ...(toolSpecs.length ? { tools: toolSpecs } : {}),
            thinking: { type: "adaptive" },
            output_config: { effort: "medium" },
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: "default",
          });
        } catch (error) {
          throw new Error(describeError(label, error));
        }
        return toTurn(response, messages, label);
      },
    };
  }
}

function toTurn(response: Anthropic.Beta.BetaMessage, messages: BetaMessageParam[], label: string) {
  if (response.stop_reason === "refusal") {
    // Nothing from a declined turn goes back into the transcript; the run ends here.
    const category = response.stop_details?.category;
    return {
      text: `${label} declined this request${category ? ` (${category})` : ""}; the run stopped.`,
      toolCalls: [],
      stop: "refusal",
    } satisfies Turn;
  }
  const content: BetaContentBlock[] = response.content;
  messages.push({ role: "assistant", content }); // verbatim, including thinking blocks
  const text = content
    .flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join("\n")
    .trim();
  const toolCalls = content.flatMap((b) =>
    b.type === "tool_use" ? [{ id: b.id, name: b.name, input: b.input }] : [],
  );
  return {
    ...(text ? { text } : {}),
    toolCalls,
    stop: toolCalls.length
      ? "tool_calls"
      : response.stop_reason === "max_tokens"
        ? "length"
        : response.stop_reason === "end_turn"
          ? "end"
          : "other",
  } satisfies Turn;
}

function describeError(label: string, error: unknown): string {
  const tries = `${MAX_RETRIES + 1} tries`;
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return `${label} did not respond within ${TIMEOUT_MS / 1000} s (${tries})`;
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return `${label}: cannot reach the API (${tries}): ${error.message}`;
  }
  if (error instanceof Anthropic.APIError) {
    return `${label} HTTP ${error.status}: ${error.message.slice(0, 300)}`;
  }
  return `${label}: ${(error as Error).message}`;
}
