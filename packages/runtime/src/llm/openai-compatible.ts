// Any OpenAI-compatible /chat/completions endpoint (Gemini, OpenRouter, vLLM, Ollama, ...).
import type { ToolDescriptor } from "@syndromi/tools";
import {
  type Conversation,
  type Fetch,
  type LlmProvider,
  parseArguments,
  postJson,
  type Turn,
} from "./types.js";

type ChatMessage = Record<string, unknown> & { role: string };
type ChatResponse = {
  choices?: {
    finish_reason?: string;
    message?: ChatMessage & {
      content?: string | null;
      tool_calls?: { id: string; function: { name: string; arguments?: string } }[];
    };
  }[];
};

const KNOWN_HOSTS: Record<string, string> = {
  "integrate.api.nvidia.com": "NVIDIA",
  "generativelanguage.googleapis.com": "Gemini",
};

/** "NVIDIA meta/muse-glimmer-30b", or the host for endpoints we don't know by name. */
export function endpointLabel(baseUrl: string, model: string): string {
  let host = baseUrl;
  try {
    host = new URL(baseUrl).host;
  } catch {}
  return `${KNOWN_HOSTS[host] ?? host} ${model}`;
}

export class OpenAICompatibleProvider implements LlmProvider {
  readonly name = "openai-compatible";
  constructor(
    private readonly opts: {
      baseUrl: string;
      model: string;
      apiKey?: string;
      fetch?: Fetch;
      maxTokens?: number;
    },
  ) {}

  get model() {
    return this.opts.model;
  }

  start(system: string, tools: ToolDescriptor[]): Conversation {
    const messages: ChatMessage[] = [{ role: "system", content: system }];
    const url = `${this.opts.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const headers: Record<string, string> = this.opts.apiKey
      ? { authorization: `Bearer ${this.opts.apiKey}` }
      : {};
    const label = endpointLabel(this.opts.baseUrl, this.opts.model);
    const toolSpecs = tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));

    return {
      send: async (input): Promise<Turn> => {
        if ("user" in input) messages.push({ role: "user", content: input.user });
        else {
          for (const r of input.toolResults) {
            messages.push({ role: "tool", tool_call_id: r.id, name: r.name, content: r.content });
          }
        }
        const body = (await postJson(
          this.opts.fetch ?? fetch,
          url,
          headers,
          {
            model: this.opts.model,
            messages,
            ...(toolSpecs.length ? { tools: toolSpecs } : {}),
            max_tokens: this.opts.maxTokens ?? 2048,
          },
          label,
        )) as ChatResponse;
        const choice = body.choices?.[0];
        const message = choice?.message;
        if (!message) throw new Error(`${label}: response had no message`);
        messages.push(message); // verbatim, including any extra_content thought signatures
        const toolCalls = (message.tool_calls ?? []).map((c) => ({
          id: c.id,
          name: c.function.name,
          input: parseArguments(c.function.arguments),
        }));
        const text = typeof message.content === "string" ? message.content : undefined;
        return {
          ...(text ? { text } : {}),
          toolCalls,
          stop: toolCalls.length
            ? "tool_calls"
            : choice.finish_reason === "length"
              ? "length"
              : choice.finish_reason === "stop"
                ? "end"
                : "other",
        };
      },
    };
  }
}
