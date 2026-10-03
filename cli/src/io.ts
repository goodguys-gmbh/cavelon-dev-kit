/**
 * Everything a command touches outside its arguments: streams, environment,
 * working directory and the clock. Tests pass their own; `cli.ts` passes the
 * process.
 */

export interface OutStream {
  write(chunk: string): unknown;
  /** True only for an interactive terminal; decides colours and prompts. */
  isTTY?: boolean;
}

export interface InStream extends AsyncIterable<Buffer | string> {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  on?(event: string, listener: (...args: never[]) => void): unknown;
  off?(event: string, listener: (...args: never[]) => void): unknown;
  resume?(): unknown;
  pause?(): unknown;
}

export interface Io {
  stdout: OutStream;
  stderr: OutStream;
  stdin: InStream;
  env: Record<string, string | undefined>;
  cwd: string;
  now(): Date;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export function processIo(): Io {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin as unknown as InStream,
    env: process.env,
    cwd: process.cwd(),
    now: () => new Date(),
    sleep: defaultSleep,
  };
}

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export async function readAll(stream: InStream): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of stream) chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  return chunks.join("");
}

/** Colours only for a terminal, never with --json, and never with NO_COLOR set. */
export function colorEnabled(io: Io, json: boolean): boolean {
  if (json || !io.stdout.isTTY) return false;
  if (io.env.NO_COLOR !== undefined && io.env.NO_COLOR !== "") return false;
  return io.env.TERM !== "dumb";
}

export interface Style {
  bold(s: string): string;
  dim(s: string): string;
  red(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
}

const plain: Style = { bold: (s) => s, dim: (s) => s, red: (s) => s, green: (s) => s, yellow: (s) => s };
const ansi = (open: number, close: number) => (s: string) => `\u001b[${open}m${s}\u001b[${close}m`;
const colored: Style = {
  bold: ansi(1, 22),
  dim: ansi(2, 22),
  red: ansi(31, 39),
  green: ansi(32, 39),
  yellow: ansi(33, 39),
};

export function styleFor(enabled: boolean): Style {
  return enabled ? colored : plain;
}
