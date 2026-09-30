// Primary model with a backup. If the primary fails on the first request of a run, the run
// starts over on the backup: no tool has run yet, so nothing repeats. A failure later in a run
// ends that run (tools already acted on the primary's plan) and benches the primary for a while,
// so the next runs start on the backup. A refusal is an answer, not an outage: no switch.
import type { ToolDescriptor } from "@syndromi/tools";
import type { Conversation, LlmNotice, LlmProvider, Turn } from "./types.js";

export const BENCH_MS = 10 * 60_000;

export class FailoverProvider implements LlmProvider {
  private benchedUntil = 0;

  constructor(
    readonly primary: LlmProvider,
    readonly backup: LlmProvider,
    private readonly now: () => number = Date.now,
  ) {}

  private get active(): LlmProvider {
    return this.now() < this.benchedUntil ? this.backup : this.primary;
  }

  get name() {
    return this.active.name;
  }

  get model() {
    return this.active.model;
  }

  start(
    system: string,
    tools: ToolDescriptor[],
    notify?: (notice: LlmNotice) => void | Promise<void>,
  ): Conversation {
    const first = this.active;
    let convo = first.start(system, tools, notify);
    let current = first;
    let started = false;

    return {
      send: async (input): Promise<Turn> => {
        try {
          const turn = await convo.send(input);
          started = true;
          return turn;
        } catch (error) {
          if (current !== this.primary) throw error;
          this.benchedUntil = this.now() + BENCH_MS;
          if (started || !("user" in input)) throw error;
          const reason = (error as Error).message;
          await notify?.({
            type: "llm_failover",
            from: `${this.primary.name}:${this.primary.model}`,
            to: `${this.backup.name}:${this.backup.model}`,
            reason,
          });
          current = this.backup;
          convo = this.backup.start(system, tools, notify);
          try {
            const turn = await convo.send(input);
            started = true;
            return turn;
          } catch (backupError) {
            throw new Error(`${reason}; backup: ${(backupError as Error).message}`);
          }
        }
      },
    };
  }
}
