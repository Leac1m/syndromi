import { getSubscriptionsErrorMessage } from "@solana/subscriptions";
import { redact } from "./cluster.js";

type Step = { name: string; ok: boolean; detail: string };

/** Collects expected-success and expected-failure steps and prints a pass/fail table. */
export class Report {
  private steps: Step[] = [];

  async expectOk<T>(name: string, run: () => Promise<T>, describe: (value: T) => string) {
    try {
      const value = await run();
      this.record(name, true, describe(value));
      return value;
    } catch (error) {
      this.record(name, false, `unexpected error: ${errorSummary(error)}`);
      return undefined;
    }
  }

  async expectFail(name: string, run: () => Promise<unknown>) {
    try {
      await run();
      this.record(name, false, "succeeded but should have failed");
    } catch (error) {
      this.record(name, true, `failed as expected: ${errorSummary(error)}`);
    }
  }

  private record(name: string, ok: boolean, detail: string) {
    this.steps.push({ name, ok, detail });
    console.log(`${ok ? "✅" : "❌"} ${name}\n   ${redact(detail)}`);
  }

  finish(): never {
    const failed = this.steps.filter((s) => !s.ok);
    console.log(`\n${this.steps.length - failed.length}/${this.steps.length} steps passed.`);
    process.exit(failed.length === 0 ? 0 : 1);
  }
}

/** Finds the most specific message in a SolanaError cause chain, decoding program error codes. */
export function errorSummary(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  while (current && messages.length < 6) {
    const e = current as { message?: string; context?: { code?: number }; cause?: unknown };
    const code = e.context?.code;
    if (typeof code === "number" && code >= 100) {
      const decoded = safeSubscriptionsMessage(code);
      if (decoded) return `program error ${code}: ${decoded}`;
    }
    if (e.message) messages.push(e.message);
    current = e.cause;
  }
  return messages.at(-1) ?? String(error);
}

function safeSubscriptionsMessage(code: number): string | undefined {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: the SDK types the code as a literal union
    return getSubscriptionsErrorMessage(code as any);
  } catch {
    return undefined;
  }
}
