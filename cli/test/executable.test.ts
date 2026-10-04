import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import { Readable } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { InStream, Io } from "../src/io.js";
import { run as runNpmBuild } from "../src/main.js";
import { startFakeServer, type FakeServer } from "./fake-server.js";

/**
 * The standalone executable (scripts/build-executable.mjs), run as a person or
 * an agent runs it, against the fake server. CI builds it on each platform and
 * names it in CAVELON_EXECUTABLE; without one, these tests are skipped.
 */

const EXECUTABLE = process.env.CAVELON_EXECUTABLE;
const version = (JSON.parse(readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")) as { version: string }).version;

let server: FakeServer;
let tenant: string;
let home: string;
let baseEnv: Record<string, string>;

/**
 * The real home folder, so the system's credential store is the one a person
 * has; the kit's own folders go to a temporary one. No CAVELON_* variable of
 * the machine running the tests leaks in.
 */
function environment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.toUpperCase().startsWith("CAVELON_")) env[key] = value;
  }
  return { ...env, CAVELON_CONFIG_DIR: path.join(home, "config"), CAVELON_CACHE_DIR: path.join(home, "cache") };
}

interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
  json(): any;
}

// Asynchronous: the fake server answers from this process.
function run(args: string[], options: { env?: Record<string, string>; stdin?: string; cwd?: string } = {}): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(EXECUTABLE!, args, { env: { ...baseEnv, ...options.env }, cwd: options.cwd ?? home, timeout: 60_000 });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (s: string) => (stdout += s));
    child.stderr.setEncoding("utf8").on("data", (s: string) => (stderr += s));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr, json: () => JSON.parse(stdout.trim().split("\n").pop()!) }));
    child.stdin.end(options.stdin ?? "");
  });
}

/** `login` as the npm package runs it, in this process, on the same machine: which store keeps the token. */
async function npmBuildStore(token: string): Promise<string> {
  let stdout = "";
  const io: Io = {
    stdout: { write: (s: string) => ((stdout += s), true) },
    stderr: { write: () => true },
    stdin: Readable.from([`${token}\n`]) as unknown as InStream,
    env: baseEnv,
    cwd: home,
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
  const code = await runNpmBuild(["login", "--instance", server.url, "--token-stdin", "--json"], io);
  if (code !== 0) throw new Error(`the npm build's login failed (${code}): ${stdout}`);
  const store = (JSON.parse(stdout.trim().split("\n").pop()!) as { credential: { store: string } }).credential.store;
  if ((await runNpmBuild(["logout", "--json"], { ...io, stdin: Readable.from([]) as unknown as InStream })) !== 0) throw new Error("the npm build's logout failed");
  return store;
}

describe.skipIf(!EXECUTABLE)("the standalone executable", () => {
  beforeAll(async () => {
    server = await startFakeServer();
    tenant = server.addTenant("acme", "Acme");
    home = mkdtempSync(path.join(os.tmpdir(), "cavelon-exe-"));
    baseEnv = environment();
  });
  afterAll(async () => {
    await run(["logout", "--all"]);
    rmSync(home, { recursive: true, force: true });
    await server?.close();
  });

  it("answers --version with the package's version", async () => {
    const plain = await run(["--version"]);
    expect(plain.code).toBe(0);
    expect(plain.stdout.trim()).toBe(version);
    expect((await run(["--version", "--json"])).json()).toEqual({ version });
  });

  it("runs whoami against an instance from CAVELON_URL and CAVELON_TOKEN", async () => {
    const token = server.addToken({ kind: "pat", tenantIds: [tenant], email: "ada@example.com" });
    const who = await run(["whoami", "--json"], { env: { CAVELON_URL: server.url, CAVELON_TOKEN: token } });
    expect(who.code, who.stderr).toBe(0);
    expect(who.json()).toMatchObject({ tenant: { id: tenant, name: "Acme" } });
  });

  it("keeps the token in the store the npm build chooses on this machine: the system's credential store, else the user-only file", async () => {
    const token = server.addToken({ kind: "pat", tenantIds: [tenant], email: "ada@example.com" });
    const expected = await npmBuildStore(token);
    const login = await run(["login", "--instance", server.url, "--token-stdin", "--json"], { stdin: `${token}\n` });
    expect(login.code, login.stderr).toBe(0);
    const store = login.json().credential.store as string;
    expect(store, login.stderr).toBe(expected);
    expect(existsSync(path.join(home, "config", "credentials.json"))).toBe(store === "file");

    const who = await run(["whoami", "--json"]);
    expect(who.code, who.stderr).toBe(0);
    expect(who.json()).toMatchObject({ tenant: { id: tenant } });

    const logout = await run(["logout", "--json"]);
    expect(logout.code, logout.stderr).toBe(0);
    expect((await run(["whoami", "--json"])).code).not.toBe(0);
  });

  it("writes the skills it carries with init --agents", async () => {
    const token = server.addToken({ kind: "pat", tenantIds: [tenant], email: "ada@example.com" });
    const dir = path.join(home, "solution");
    mkdirSync(dir);
    const init = await run(["init", "--tenant", tenant, "--agents", "claude", "--json"], { cwd: dir, env: { CAVELON_URL: server.url, CAVELON_TOKEN: token } });
    expect(init.code, init.stderr + init.stdout).toBe(0);
    for (const skill of ["cavelon-loop", "cavelon-authoring", "cavelon-testing", "cavelon-long-running"]) {
      const text = readFileSync(path.join(dir, ".claude", "skills", skill, "SKILL.md"), "utf8");
      expect(text).toContain(`(cavelon ${version})`);
    }
  });

  it("serves MCP over stdio: the handshake, the tools and a call", async () => {
    const token = server.addToken({ kind: "pat", tenantIds: [tenant], email: "ada@example.com" });
    const transport = new StdioClientTransport({
      command: EXECUTABLE!,
      args: ["mcp"],
      cwd: home,
      env: { ...baseEnv, CAVELON_URL: server.url, CAVELON_TOKEN: token },
      stderr: "pipe",
    });
    const client = new Client({ name: "executable-test", version: "0" });
    try {
      await client.connect(transport);
      expect(client.getServerVersion()).toMatchObject({ name: "cavelon", version });
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("whoami");
      const result = await client.callTool({ name: "whoami", arguments: {} });
      expect(result.isError ?? false).toBe(false);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(JSON.parse(content[0]!.text)).toMatchObject({ tenant: { id: tenant } });
    } finally {
      await client.close();
    }
  });
});
