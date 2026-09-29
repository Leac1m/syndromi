// Terminal I/O behind an interface, so commands can be tested without a TTY.
import { createInterface } from "node:readline/promises";

export type Io = {
  print(line: string): void;
  /** Ask a question; resolves to the answer, or undefined when there is no terminal. */
  ask(question: string): Promise<string | undefined>;
  /** Ask without echoing (passphrases). */
  secret(question: string): Promise<string | undefined>;
};

export const terminalIo: Io = {
  print: (line) => console.log(line),
  async ask(question) {
    if (!process.stdin.isTTY) return undefined;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  },
  async secret(question) {
    if (!process.stdin.isTTY) return undefined;
    process.stdout.write(question);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    return new Promise((resolve) => {
      const onData = (char: string) => {
        if (char === "\r" || char === "\n" || char === "\u0004") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(value);
        } else if (char === "\u0003") {
          process.stdout.write("\n");
          process.exit(130);
        } else if (char === "\u007f") {
          value = value.slice(0, -1);
        } else {
          value += char;
        }
      };
      stdin.on("data", onData);
    });
  },
};

export class CliError extends Error {}
