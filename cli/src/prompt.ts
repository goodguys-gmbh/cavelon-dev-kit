import { CavelonError, ExitCode } from "./errors.js";
import type { Io } from "./io.js";

/**
 * Read a secret from the terminal without echoing it. Only `login` and
 * `secrets set` call this, and only when both stdin and stderr are a
 * terminal; everywhere else the value comes through standard input.
 */
export function readHidden(io: Io, label: string, cancelled = "Login cancelled."): Promise<string> {
  const stdin = io.stdin;
  return new Promise((resolve, reject) => {
    let value = "";
    io.stderr.write(label);
    const finish = (error?: Error) => {
      stdin.setRawMode?.(false);
      stdin.off?.("data", onData as never);
      stdin.pause?.();
      io.stderr.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: Buffer | string) => {
      for (const char of typeof chunk === "string" ? chunk : chunk.toString("utf8")) {
        if (char === "\r" || char === "\n") return finish();
        if (char === "\u0003" || char === "\u0004") {
          return finish(new CavelonError(ExitCode.failure, { code: "cancelled", message: cancelled }));
        }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " ") value += char;
      }
    };
    stdin.setRawMode?.(true);
    stdin.on?.("data", onData as never);
    stdin.resume?.();
  });
}
