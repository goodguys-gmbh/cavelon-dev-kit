import { execFile, spawn } from "node:child_process";
import path from "node:path";

/**
 * Another program the kit runs for a person (an agent's own plugin command,
 * or the MCP server as the agent will start it): without a shell, bounded in
 * time and output, and never with a token or secret in its arguments.
 */

export interface ProgramResult {
  /** The exit code, or null when the program could not start or was stopped. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Why it did not run to its end: not found, timed out. */
  error?: string;
}

const MAX_OUTPUT = 4 * 1024 * 1024;

/**
 * How a program found on PATH is started. A Windows batch file (`claude.cmd`
 * from npm) runs only through cmd, which reads its own quoting: every word the
 * kit passes is fixed by the kit, and the program's path is quoted.
 */
export function invocation(
  file: string,
  args: string[],
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): { file: string; args: string[]; verbatim: boolean } {
  if (platform === "win32" && /\.(cmd|bat)$/i.test(file)) {
    const line = [`"${file}"`, ...args.map((a) => (/^[\w@./:=-]+$/.test(a) ? a : `"${a.replaceAll('"', '""')}"`))].join(" ");
    return { file: env.ComSpec || env.COMSPEC || "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], verbatim: true };
  }
  return { file, args, verbatim: false };
}

export function runProgram(
  file: string,
  args: string[],
  options: { env: Record<string, string | undefined>; cwd?: string; timeoutMs: number },
): Promise<ProgramResult> {
  const how = invocation(file, args, options.env);
  return new Promise((resolve) => {
    const child = execFile(
      how.file,
      how.args,
      {
        env: options.env as NodeJS.ProcessEnv,
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: MAX_OUTPUT,
        windowsHide: true,
        windowsVerbatimArguments: how.verbatim,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (!error) return resolve({ code: 0, stdout, stderr });
        const err = error as NodeJS.ErrnoException & { killed?: boolean; code?: string | number };
        if (err.killed) return resolve({ code: null, stdout, stderr, error: `${path.basename(file)} did not finish within ${Math.round(options.timeoutMs / 1000)} s` });
        if (typeof err.code === "number") return resolve({ code: err.code, stdout, stderr });
        resolve({ code: null, stdout, stderr, error: err.message });
      },
    );
    // Nobody answers: a program that asks (Gemini CLI's folder trust, a fallback to git clone) reads no and ends, rather than waiting out the timeout.
    child.stdin?.end();
  });
}

export interface McpProbe {
  ok: boolean;
  /** The server's name and version, as it announced them. */
  server?: string;
  error?: string;
}

/**
 * Start an MCP server over stdio as an agent would, ask it to initialize,
 * and stop it: proves that the command an agent's entry names starts and
 * speaks MCP. The first start through npx downloads the package, so the
 * bound is generous.
 */
export function probeMcpServer(
  command: string,
  args: string[],
  options: { env: Record<string, string | undefined>; cwd?: string; timeoutMs: number; clientVersion: string },
): Promise<McpProbe> {
  return new Promise((resolve) => {
    let settled = false;
    let out = "";
    let err = "";
    const child = spawn(command, args, { env: options.env as NodeJS.ProcessEnv, cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const finish = (probe: McpProbe) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      resolve(probe);
    };
    const timer = setTimeout(() => finish({ ok: false, error: `it did not answer within ${Math.round(options.timeoutMs / 1000)} s` }), options.timeoutMs);
    child.on("error", (error) => finish({ ok: false, error: (error as NodeJS.ErrnoException).code === "ENOENT" ? `${command} was not found` : error.message }));
    child.on("exit", (code) => finish({ ok: false, error: `it stopped (exit ${code ?? "signal"})${err.trim() ? `: ${lastLine(err)}` : ""}` }));
    child.stderr.on("data", (chunk: Buffer) => {
      if (err.length < MAX_OUTPUT) err += chunk.toString("utf8");
    });
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      if (out.length > MAX_OUTPUT) return finish({ ok: false, error: "it wrote more than an MCP answer" });
      let newline: number;
      while ((newline = out.indexOf("\n")) >= 0) {
        const line = out.slice(0, newline).trim();
        out = out.slice(newline + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line) as { id?: unknown; result?: { serverInfo?: { name?: string; version?: string } }; error?: { message?: string } };
          if (message.id !== 1) continue;
          if (message.result) {
            const info = message.result.serverInfo;
            return finish({ ok: true, server: info ? `${info.name ?? "?"} ${info.version ?? ""}`.trim() : undefined });
          }
          return finish({ ok: false, error: message.error?.message ?? "it refused to initialize" });
        } catch {
          // Not JSON-RPC: something printed to stdout before the server started; keep reading.
        }
      }
    });
    child.stdin.on("error", () => undefined);
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cavelon-setup-check", version: options.clientVersion } },
      }) + "\n",
    );
  });
}

function lastLine(text: string): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  return (lines[lines.length - 1] ?? "").slice(0, 300);
}
