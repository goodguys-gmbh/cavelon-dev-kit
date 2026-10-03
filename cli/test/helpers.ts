import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { Io, InStream } from "../src/io.js";
import { run } from "../src/main.js";

/** Run the CLI in-process, as a non-interactive agent would by default. */

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  json<T = Record<string, unknown>>(): T;
}

export interface Sandbox {
  home: string;
  env: Record<string, string>;
  cleanup(): void;
}

export function sandbox(): Sandbox {
  const home = mkdtempSync(path.join(os.tmpdir(), "cavelon-test-"));
  return {
    home,
    env: {
      HOME: home,
      CAVELON_CONFIG_DIR: path.join(home, "config"),
      CAVELON_CACHE_DIR: path.join(home, "cache"),
      CAVELON_CREDENTIAL_STORE: "file",
      CAVELON_POLL_INTERVAL_MS: "20",
    },
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

export interface RunOptions {
  env?: Record<string, string | undefined>;
  stdin?: string;
  cwd?: string;
  tty?: boolean;
  /** The clock the CLI reads, to age its cache without waiting. */
  now?: () => Date;
}

export async function cli(sb: Sandbox, args: string[], options: RunOptions = {}): Promise<CliResult> {
  let stdout = "";
  let stderr = "";
  const stdin = Readable.from(options.stdin !== undefined ? [options.stdin] : []) as unknown as InStream;
  stdin.isTTY = options.tty ?? false;
  const io: Io = {
    stdout: { write: (s: string) => ((stdout += s), true), isTTY: options.tty ?? false },
    stderr: { write: (s: string) => ((stderr += s), true), isTTY: options.tty ?? false },
    stdin,
    env: { ...sb.env, ...options.env },
    cwd: options.cwd ?? sb.home,
    now: options.now ?? (() => new Date()),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
  const code = await run(args, io);
  return {
    code,
    stdout,
    stderr,
    json<T>() {
      const line = stdout.trim().split("\n").pop() ?? "";
      try {
        return JSON.parse(line) as T;
      } catch {
        throw new Error(`stdout is not JSON (exit ${code}):\n${stdout}\nstderr:\n${stderr}`);
      }
    },
  };
}

/** Log in through --token-stdin, as a person would once. */
export async function login(sb: Sandbox, url: string, token: string, extra: string[] = []): Promise<CliResult> {
  const result = await cli(sb, ["login", "--instance", url, "--token-stdin", ...extra], { stdin: `${token}\n` });
  if (result.code !== 0) throw new Error(`login failed (${result.code}): ${result.stderr}${result.stdout}`);
  return result;
}
