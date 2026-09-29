// Anthropic Messages API, bring-your-own-key.
import type { ToolDescriptor } from "@syndromi/tools";
import { type Conversation, type Fetch, type LlmProvider, postJson, type Turn } from "./types.js";

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: string; [k: string]: unknown };
type MessagesResponse = { content?: ContentBlock[]; stop_reason?: string };

export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5";

export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  constructor(
    private readonly opts: {
      apiKey: string;
      model?: string;
      baseUrl?: string;
      fetch?: Fetch;
      maxTokens?: number;
    },
  ) {}

  get model() {
    return this.opts.model ?? DEFAULT_ANTHROPIC_MODEL;
  }

  start(system: string, tools: ToolDescriptor[]): Conversation {
    const messages: { role: "user" | "assistant"; content: unknown }[] = [];
    const url = `${(this.opts.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "")}/v1/messages`;
    const headers = { "x-api-key": this.opts.apiKey, "anthropic-version": "2023-06-01" };
    const toolSpecs = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));

    return {
      send: async (input): Promise<Turn> => {
        messages.push(
          "user" in input
            ? { role: "user", content: input.user }
            : {
                role: "user",
                content: input.toolResults.map((r) => ({
                  type: "tool_result",
                  tool_use_id: r.id,
                  content: r.content,
                })),
              },
        );
        const body = (await postJson(
          this.opts.fetch ?? fetch,
          url,
          headers,
          {
            model: this.model,
            max_tokens: this.opts.maxTokens ?? 2048,
            system,
            messages,
            ...(toolSpecs.length ? { tools: toolSpecs } : {}),
          },
          this.model,
        )) as MessagesResponse;
        const content = body.content ?? [];
        messages.push({ role: "assistant", content }); // verbatim, including thinking blocks
        const text = content
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("\n");
        const toolCalls = content
          .filter(
            (b): b is { type: "tool_use"; id: string; name: string; input: unknown } =>
              b.type === "tool_use",
          )
          .map((b) => ({ id: b.id, name: b.name, input: b.input }));
        return {
          ...(text ? { text } : {}),
          toolCalls,
          stop: toolCalls.length
            ? "tool_calls"
            : body.stop_reason === "max_tokens"
              ? "length"
              : body.stop_reason === "end_turn"
                ? "end"
                : "other",
        };
      },
    };
  }
}
