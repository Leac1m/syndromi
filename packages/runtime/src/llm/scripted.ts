// A deterministic provider for tests and rehearsals: replays turns, optionally computed from the
// tool results the loop sent back.
import type { ToolDescriptor } from "@syndromi/tools";
import type { Conversation, LlmProvider, ToolResultMessage, Turn } from "./types.js";

export type ScriptStep = Turn | ((lastResults: ToolResultMessage[]) => Turn);

export class ScriptedProvider implements LlmProvider {
  readonly name = "scripted";
  readonly model = "script";
  /** Everything the loop sent, for assertions. */
  readonly received: { system: string; tools: string[]; inputs: unknown[] }[] = [];

  /**
   * `paceMs`: wait this long before every turn after the first, so a person watching a scripted
   * run sees one move at a time instead of all of them at once.
   */
  constructor(
    private readonly steps: readonly ScriptStep[],
    private readonly opts: { paceMs?: number } = {},
  ) {}

  start(system: string, tools: ToolDescriptor[]): Conversation {
    let i = 0;
    const log = { system, tools: tools.map((t) => t.name), inputs: [] as unknown[] };
    this.received.push(log);
    return {
      send: async (input) => {
        log.inputs.push(input);
        if (i > 0 && this.opts.paceMs) await new Promise((r) => setTimeout(r, this.opts.paceMs));
        const step = this.steps[i++];
        if (!step) return { text: "(script finished)", toolCalls: [], stop: "end" };
        return typeof step === "function"
          ? step("toolResults" in input ? input.toolResults : [])
          : step;
      },
    };
  }
}

let nextId = 0;
export const call = (name: string, input: unknown = {}) => ({
  id: `call_${++nextId}`,
  name,
  input,
});
export const useTools = (...calls: ReturnType<typeof call>[]): Turn => ({
  toolCalls: calls,
  stop: "tool_calls",
});
/** A tool call with a line of narration, as a model that thinks aloud would produce. */
export const say = (text: string, ...calls: ReturnType<typeof call>[]): Turn => ({
  text,
  toolCalls: calls,
  stop: "tool_calls",
});
export const finish = (text: string): Turn => ({ text, toolCalls: [], stop: "end" });
