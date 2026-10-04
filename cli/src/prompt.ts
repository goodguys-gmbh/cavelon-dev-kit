import { CavelonError, ExitCode } from "./errors.js";
import type { Context } from "./command.js";
import type { InStream, Io } from "./io.js";

/**
 * Read from the terminal: a secret without echoing it (only `login` and
 * `secrets set`), or one answer to a question (the tenant and solution
 * pickers). Only when both stdin and stderr are a terminal; everywhere else
 * the value comes through standard input or an option.
 */

/** What a terminal sent past the end of the line just read, kept for the next question. */
const leftover = new WeakMap<InStream, string>();

/** Whether a person can be asked: a terminal on both ends, no --json, and never an MCP tool. */
export function canAsk(ctx: Pick<Context, "io" | "json" | "mode">): boolean {
  return ctx.mode === "cli" && !ctx.json && Boolean(ctx.io.stdin.isTTY) && Boolean(ctx.io.stderr.isTTY);
}

function cancelledError(message: string): CavelonError {
  return new CavelonError(ExitCode.failure, { code: "cancelled", message });
}

function readUntilLine(io: Io, label: string, hidden: boolean, cancelled: string): Promise<string> {
  const stdin = io.stdin;
  return new Promise((resolve, reject) => {
    let value = "";
    let done = false;
    io.stderr.write(label);
    const finish = (error?: Error, rest = "") => {
      done = true;
      if (rest) leftover.set(stdin, rest);
      else leftover.delete(stdin);
      if (hidden) stdin.setRawMode?.(false);
      stdin.off?.("data", onData as never);
      stdin.off?.("end", onEnd as never);
      stdin.pause?.();
      if (hidden || error) io.stderr.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const take = (text: string) => {
      const chars = [...text];
      for (let i = 0; i < chars.length; i++) {
        const char = chars[i]!;
        if (char === "\r" || char === "\n") {
          // A terminal in raw mode ends a line with \r; a pipe or a cooked terminal with \n, sometimes both.
          const next = char === "\r" && chars[i + 1] === "\n" ? i + 2 : i + 1;
          return finish(undefined, chars.slice(next).join(""));
        }
        if (char === "\u0003" || char === "\u0004") return finish(cancelledError(cancelled));
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " ") value += char;
      }
    };
    const onData = (chunk: Buffer | string) => {
      if (!done) take(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    };
    const onEnd = () => {
      if (!done) finish(cancelledError(cancelled));
    };
    const pending = leftover.get(stdin);
    if (pending) {
      leftover.delete(stdin);
      take(pending);
      if (done) return;
    }
    if (stdin.readableEnded) return finish(cancelledError(cancelled));
    if (hidden) stdin.setRawMode?.(true);
    stdin.on?.("data", onData as never);
    stdin.on?.("end", onEnd as never);
    stdin.resume?.();
  });
}

/** Read a secret from the terminal without echoing it. */
export function readHidden(io: Io, label: string, cancelled = "Login cancelled."): Promise<string> {
  return readUntilLine(io, label, true, cancelled);
}

/** Read one line the person types, trimmed. Ctrl+C, Ctrl+D and the end of input cancel. */
export async function readLine(io: Io, label: string, cancelled = "Cancelled; nothing was chosen."): Promise<string> {
  return (await readUntilLine(io, label, false, cancelled)).trim();
}
