import { Cron } from "croner";

/**
 * Runs `task` on a 5-field cron schedule. Overlapping runs are skipped (a slow LLM or RPC never
 * stacks runs), and errors are reported instead of stopping the schedule.
 */
export function schedule(
  cron: string,
  task: () => Promise<unknown>,
  opts: { onError?: (error: unknown) => void; onSkip?: () => void } = {},
) {
  const job = new Cron(
    cron,
    {
      protect: () => opts.onSkip?.(),
      catch: (error: unknown) => opts.onError?.(error),
    },
    async () => {
      await task();
    },
  );
  return { next: () => job.nextRun(), stop: () => job.stop() };
}
