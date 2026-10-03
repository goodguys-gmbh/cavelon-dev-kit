import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { COMMANDS } from "../src/commands/index.js";
import { CAPACITY_CONCEPT_PAGE, CAPACITY_TUTORIAL_PAGE } from "../src/capacity.js";
import { ExitCode } from "../src/errors.js";
import { CONTRACTS, startFakeServer, type FakeServer } from "./fake-server.js";
import { cli, login, sandbox, type Sandbox } from "./helpers.js";

/**
 * Plan 04, "Built for agents": no prompts, --json everywhere, no colour
 * without a terminal, documented exit codes, bounded waits and output, and
 * every command marked read-only or changing.
 */

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[`);
const DOCUMENTED = new Set<number>(Object.values(ExitCode));

let server: FakeServer;
let sb: Sandbox;
let token: string;

beforeAll(async () => {
  server = await startFakeServer();
  const tenant = server.addTenant("acme");
  sb = sandbox();
  token = server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant });
  await login(sb, server.url, token);
});
afterAll(async () => {
  sb.cleanup();
  await server.close();
});

describe("every command", () => {
  it.each(COMMANDS.map((c) => [c.name]))("%s has help that says whether it is read-only", async (name) => {
    const result = await cli(sb, [...name.split(" "), "--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^Usage: cavelon /);
    expect(result.stdout).toMatch(/Marked: (read-only|changing)/);
    expect(result.stdout).toMatch(/--json/);
  });

  it("is listed with its read-only marking and MCP tool", async () => {
    const result = await cli(sb, ["commands", "--json"]);
    const items = result.json<{ items: Array<{ command: string; read_only: boolean; mcp_tool: string | null }> }>().items;
    expect(items.map((i) => i.command)).toEqual(COMMANDS.map((c) => c.name));
    for (const item of items) expect(typeof item.read_only).toBe("boolean");
    // The plan's allowlist for agents: these never change anything.
    for (const name of ["validate", "status", "docs search", "docs get", "explain", "whoami", "wait", "trace"]) {
      expect(items.find((i) => i.command === name)!.read_only, name).toBe(true);
    }
  });

  it.each(COMMANDS.filter((c) => c.name !== "mcp" && c.name !== "commands").map((c) => [c.name]))(
    "%s answers --json with one JSON document and a documented exit code, even when it fails",
    async (name) => {
      // No instance at all: every command must still fail cleanly, in JSON.
      const bare = sandbox();
      try {
        const spec = COMMANDS.find((c) => c.name === name)!;
        const required = (spec.positionals ?? []).filter((p) => p.required).map(() => "x");
        const result = await cli(bare, [...name.split(" "), ...required, "--json"]);
        expect(DOCUMENTED.has(result.code), `exit ${result.code}`).toBe(true);
        const lines = result.stdout.trim().split("\n");
        expect(lines).toHaveLength(1);
        expect(() => JSON.parse(lines[0]!)).not.toThrow();
        expect(result.stdout + result.stderr).not.toMatch(ANSI);
      } finally {
        bare.cleanup();
      }
    },
  );
});

describe("output without a terminal", () => {
  it("has no colours or progress lines", async () => {
    server.state.capsPatch = { contracts: { api_version: "v9" } };
    try {
      const plain = await cli(sb, ["status"], { env: { CAVELON_CONTRACT_TTL_SECONDS: "0" } });
      expect(plain.stdout + plain.stderr).not.toMatch(ANSI);
      const op = server.addOperation("test_run", server.state.tenants[0]!.id, ["running", "succeeded"]);
      const waited = await cli(sb, ["wait", op.id]);
      expect(waited.stderr).toBe("");
      expect(waited.stdout).not.toMatch(ANSI);
    } finally {
      server.state.capsPatch = {};
    }
  });

  it("colours only on a terminal, and never with NO_COLOR", async () => {
    const bad = await cli(sb, ["whoami", "--token", "x"], { tty: true });
    expect(bad.stderr).not.toMatch(ANSI); // errors stay plain everywhere
    const tty = await cli(sb, ["login", "--instance", server.url, "--token-stdin"], { tty: true, stdin: "cvpat_bad\n" });
    expect(tty.code).toBe(7);
    const warned = await cli(sb, ["logout", "--instance", "https://nowhere.example.com"], { tty: true, env: { CAVELON_TOKEN: "x" } });
    expect(warned.stderr).toMatch(ANSI);
    const noColor = await cli(sb, ["logout", "--instance", "https://nowhere.example.com"], { tty: true, env: { CAVELON_TOKEN: "x", NO_COLOR: "1" } });
    expect(noColor.stderr).not.toMatch(ANSI);
  });
});

describe("usage errors", () => {
  it("exit 2 for an unknown command, an unknown option, or a missing argument", async () => {
    expect((await cli(sb, ["frobnicate"])).code).toBe(2);
    expect((await cli(sb, ["tenant", "explode"])).code).toBe(2);
    expect((await cli(sb, ["whoami", "--colour"])).code).toBe(2);
    expect((await cli(sb, ["harness", "new"])).code).toBe(2);
    expect((await cli(sb, [])).code).toBe(2);
    expect((await cli(sb, ["--version"])).stdout).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("skills", () => {
  // The Agent Skills format: a folder per skill with SKILL.md, whose front
  // matter names it like its folder and says what it does and when to use it.
  it("ship in the Agent Skills format, provider-neutral", async () => {
    const { bundledSkills } = await import("../src/agents.js");
    const skills = await bundledSkills();
    expect(skills.map((s) => s.name)).toEqual(["cavelon-authoring", "cavelon-long-running", "cavelon-loop", "cavelon-testing"]);
    for (const skill of skills) {
      const text = skill.files.find((f) => f.path === "SKILL.md")!.content;
      const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
      expect(front, skill.name).not.toBeNull();
      const meta = parse(front![1]!) as { name: string; description: string };
      expect(meta.name).toBe(skill.name);
      expect(meta.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(meta.name.length).toBeLessThanOrEqual(64);
      expect(meta.description.length).toBeGreaterThan(50);
      expect(meta.description.length).toBeLessThanOrEqual(1024);
      expect(Object.keys(meta).every((k) => ["name", "description", "license", "compatibility", "metadata", "allowed-tools"].includes(k))).toBe(true);
      // One text for every client: no client's own tool names.
      expect(text).not.toMatch(/\b(Bash|Read|Edit|Write|TodoWrite)\(|CLAUDE\.md|\.claude\//);
      // Each one points the agent at the instance's docs instead of copying them.
      expect(text).toMatch(/cavelon docs search/);
      // A skill never asks for a token.
      expect(text).not.toMatch(/paste (the|your) token/i);
    }
  });

  it("point to the instance's capacity pages, read with docs get", async () => {
    const { bundledSkills } = await import("../src/agents.js");
    const skills = await bundledSkills();
    const text = (name: string) => skills.find((s) => s.name === name)!.files.find((f) => f.path === "SKILL.md")!.content;
    const authoring = text("cavelon-authoring");
    const longRunning = text("cavelon-long-running");
    // The tutorial where a self-hosted endpoint is set up, the concept where runs wait for capacity.
    expect(authoring).toContain(`cavelon docs get ${CAPACITY_TUTORIAL_PAGE}`);
    expect(longRunning).toContain(`cavelon docs get ${CAPACITY_CONCEPT_PAGE}`);
    // Both pages are in the snapshot's docs index, so the commands the skills name find them.
    const index = readFileSync(path.join(CONTRACTS, "docs", "llms.txt"), "utf8");
    for (const page of [CAPACITY_TUTORIAL_PAGE, CAPACITY_CONCEPT_PAGE]) expect(index).toContain(`/api/v1/docs/${page}.md)`);
    // An agent proposes a limit and the person decides.
    expect(authoring).toMatch(/cavelon models set-limit\s+<model_id> <n\|none>/);
    expect(authoring).toMatch(/\*\*Propose a limit; the person decides\.\*\*/);
    expect(authoring).toMatch(/never raise or lower a limit without telling them/);
    expect(longRunning).toMatch(/The person decides; only then run\s+`cavelon models set-limit/);
  });
});

describe("secrets", () => {
  it("never print the token, whatever the command", async () => {
    for (const args of [["whoami"], ["status"], ["whoami", "--json"], ["status", "--json"], ["harness", "list", "--json"], ["api", "list_harnesses"]]) {
      const result = await cli(sb, args);
      expect(result.stdout + result.stderr).not.toContain(token);
    }
  });
});

describe("README", () => {
  it("documents the exit codes the binary uses", () => {
    const readme = readFileSync(path.resolve(__dirname, "../../README.md"), "utf8");
    for (const [name, code] of Object.entries(ExitCode)) {
      expect(readme, `exit code ${code} (${name})`).toMatch(new RegExp(`\\|\\s*${code}\\s*\\|`));
    }
  });
});
