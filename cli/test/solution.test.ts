import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { shellWord } from "../src/shell.js";
import { CONTRACTS, modelRow, startFakeServer, type FakeServer } from "./fake-server.js";
import { cli, login, sandbox, type Sandbox } from "./helpers.js";

/**
 * Solution as code: init, pull, edit, validate,
 * apply and apply --confirm against a fake instance, and the rule that the kit
 * never overwrites a customer's file.
 */

let server: FakeServer;
let sb: Sandbox;
let tenant: string;
let token: string;
let dirCount = 0;

const read = (file: string) => readFileSync(file, "utf8");

function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function gitIn(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=dev@example.com", "-c", "user.name=Dev", "-c", "commit.gpgsign=false", ...args], {
    cwd: dir,
    encoding: "utf8",
  });
}

/** A fresh folder for one solution. */
function folder(name = "solution"): string {
  const dir = path.join(sb.home, `${name}-${++dirCount}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Run as if on another operating system: the MCP entry `init --agents` writes depends on it. */
async function onPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...original, value: platform });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

async function initSolution(extra: string[] = []): Promise<string> {
  const dir = folder();
  const result = await cli(sb, ["init", "--instance", server.url, "--tenant", tenant, "--harness", "support", ...extra], { cwd: dir });
  expect(result.code, result.stderr + result.stdout).toBe(0);
  return dir;
}

beforeAll(async () => {
  server = await startFakeServer();
  tenant = server.addTenant("acme", "Acme");
  sb = sandbox();
  token = server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant, mayActivate: true });
  await login(sb, server.url, token);
  await cli(sb, ["harness", "new", "support", "--name", "Support"]);
});
afterAll(async () => {
  sb.cleanup();
  await server.close();
});
beforeEach(() => {
  // Every test starts from the sample package; an Admin edit stays in its test.
  server.state.configs.clear();
  server.state.previewExtras = {};
  server.state.previewBlockers = [];
  server.state.importRequirementsChanged = null;
  server.state.requests.length = 0;
  server.state.ready = true;
  server.state.readinessBlockers = undefined;
  server.state.readinessChecks = undefined;
  server.state.readinessWarnings = undefined;
  server.state.readinessWithoutChecks = false;
});

describe("init chooses the tenant and the solution", () => {
  let other: Sandbox;
  let globex: string;
  let multi: string;
  beforeAll(async () => {
    globex = server.addTenant("globex", "Globex");
    multi = server.addToken({ kind: "pat", tenantIds: [tenant, globex] });
    const owner = sandbox();
    try {
      await login(owner, server.url, server.addToken({ kind: "pat", tenantIds: [globex] }));
      for (const [slug, name] of [["expense-approval", "Expense Approval"], ["support-faq", "Support FAQ"]] as const) {
        expect((await cli(owner, ["harness", "new", slug, "--name", name])).code).toBe(0);
      }
    } finally {
      owner.cleanup();
    }
  });
  beforeEach(async () => {
    other = sandbox();
    // Stored, with no tenant chosen yet: login exits 2 without a terminal.
    await cli(other, ["login", "--instance", server.url, "--token-stdin"], { stdin: multi });
  });
  afterEach(() => other.cleanup());
  const atTerminal = (dir: string, args: string[], ...lines: string[]) =>
    cli(other, args, { cwd: dir, tty: true, stdin: lines.map((l) => `${l}\n`).join(""), env: { NO_COLOR: "1" } });
  const dirFor = () => {
    const dir = path.join(other.home, `solution-${++dirCount}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  it("on a terminal: asks for the tenant, then one of its solutions, and writes their slugs", async () => {
    const dir = dirFor();
    const result = await atTerminal(dir, ["init"], "globex", "2");
    expect(result.code, result.stderr + result.stdout).toBe(0);
    expect(result.stderr).toContain("This token reaches 2 tenants");
    expect(result.stderr).toMatch(/This tenant has 2 solutions; choose one, or start a new one:\n {3}1 {2}Expense Approval {2}expense-approval {2}\(draft\)\n {3}2 {2}Support FAQ {2}support-faq {2}\(draft\)\n {3}3 {2}a new solution \(or type new\)/);
    const yaml = read(path.join(dir, "cavelon.yaml"));
    expect(yaml).toContain(`tenant: globex  # Globex, ${globex}\n`);
    expect(parse(yaml)).toMatchObject({ tenant: "globex", harness: "support-faq" });
    expect(parse(read(path.join(dir, "env", "test.yaml")))).toEqual({ harness: "support-faq" });
    expect(result.stdout).toContain("Bring the solution into package/: cavelon pull");
  });

  it("on a terminal: a new solution by name gets a slug from the name and is created as a draft", async () => {
    const dir = dirFor();
    const result = await atTerminal(dir, ["init", "--tenant", "Globex"], "new", "Résumé Screening!");
    expect(result.code, result.stderr + result.stdout).toBe(0);
    expect(result.stderr).toContain("Created the draft solution Résumé Screening! (resume-screening).");
    expect(parse(read(path.join(dir, "cavelon.yaml")))).toMatchObject({ tenant: "globex", harness: "resume-screening" });
    const created = server.state.harnesses.find((h) => h.tenant_id === globex && h.slug === "resume-screening");
    expect(created?.name).toBe("Résumé Screening!");
    expect(result.stdout).toContain("Write the package files in package/, then: cavelon validate");
  });

  it("without a terminal: refuses to guess the tenant, with one ready init line per tenant", async () => {
    const result = await cli(other, ["init", "--json"], { cwd: dirFor() });
    expect(result.code).toBe(2);
    const error = result.json<{ error: { code: string; message: string; hint: string; details: { tenants: Array<{ command: string }> } } }>().error;
    expect(error.code).toBe("tenant_required");
    expect(error.message).toMatch(/^A solution belongs to one tenant\. This token reaches 2 tenants/);
    expect(error.details.tenants.map((t) => t.command)).toEqual(["cavelon init --tenant acme", "cavelon init --tenant globex"]);
  });

  it("without a terminal: names the tenant's solutions as next steps, and finds --harness by its name", async () => {
    const listed = await cli(other, ["init", "--tenant", "globex", "--json"], { cwd: dirFor() });
    expect(listed.code, listed.stdout).toBe(0);
    const data = listed.json<{ next: string[]; solutions: Array<{ slug: string }> }>();
    expect(data.solutions.map((h) => h.slug)).toEqual(expect.arrayContaining(["expense-approval", "support-faq"]));
    expect(data.next).toEqual(expect.arrayContaining(["  cavelon pull --harness support-faq    Support FAQ"]));

    const dir = dirFor();
    const byName = await cli(other, ["init", "--tenant", "Globex", "--harness", "support faq"], { cwd: dir });
    expect(byName.code, byName.stderr).toBe(0);
    expect(parse(read(path.join(dir, "cavelon.yaml")))).toMatchObject({ tenant: "globex", harness: "support-faq" });

    // A solution that is not there yet is created as a draft with the name given; a name close to another one's is refused.
    const later = dirFor();
    const fresh = await cli(other, ["init", "--tenant", "globex", "--harness", "Brand New", "--json"], { cwd: later });
    expect(fresh.code, fresh.stdout).toBe(0);
    expect(fresh.stderr).toContain("Created the draft solution Brand New (brand-new).");
    expect(server.state.harnesses.find((h) => h.tenant_id === globex && h.slug === "brand-new")).toMatchObject({ name: "Brand New", status: "draft" });
    expect(parse(read(path.join(later, "cavelon.yaml")))).toMatchObject({ harness: "brand-new" });
    expect(parse(read(path.join(later, "env", "test.yaml")))).toEqual({ harness: "brand-new" });
    expect(fresh.json<{ next: string[] }>().next).toEqual(expect.arrayContaining(["Write the package files in package/, then: cavelon validate"]));
    const miss = await cli(other, ["init", "--tenant", "globex", "--harness", "Support FA", "--json"], { cwd: dirFor() });
    expect(miss.code).toBe(1);
    const missed = miss.json<{ error: { code: string; hint: string } }>().error;
    expect(missed.hint).toContain(`For a new solution of that name: cavelon init --harness ${shellWord("Support FA")} --new --tenant globex.`);
    expect(missed.hint).not.toContain("does too");
    expect(miss.json<{ error: { code: string; hint: string } }>().error).toMatchObject({ code: "solution_not_found", hint: expect.stringContaining("cavelon init --harness support-faq --tenant globex") });
    expect(server.state.harnesses.find((h) => h.tenant_id === globex && h.slug === "support-fa")).toBeUndefined();

    // --new creates it on purpose, beside the similar name; and refuses a name the tenant already has.
    const meant = await cli(other, ["init", "--tenant", "globex", "--harness", "Support FA", "--new", "--json"], { cwd: dirFor() });
    expect(meant.code, meant.stdout).toBe(0);
    expect(meant.stderr).toContain("Created the draft solution Support FA (support-fa).");
    expect(server.state.harnesses.find((h) => h.tenant_id === globex && h.slug === "support-fa")).toMatchObject({ name: "Support FA", status: "draft" });
    const taken = await cli(other, ["init", "--tenant", "globex", "--harness", "support-faq", "--new", "--json"], { cwd: dirFor() });
    expect(taken.code).toBe(1);
    expect(taken.json<{ error: { code: string; hint: string } }>().error).toMatchObject({
      code: "solution_exists",
      hint: expect.stringContaining("cavelon init --harness support-faq --tenant globex"),
    });
    const bare = await cli(other, ["init", "--tenant", "globex", "--new"], { cwd: dirFor() });
    expect(bare.code).toBe(2);
    expect(bare.stderr).toContain("--new needs the new solution's name");
  });
});

describe("init", () => {
  it("creates its own files and folders and the uncommitted .cavelon/", async () => {
    const dir = await initSolution();
    const project = parse(read(path.join(dir, "cavelon.yaml")));
    // The tenant's slug, with a comment that names it.
    expect(project).toMatchObject({ instance: server.url, tenant: "acme", harness: "support", package_version: "v3", layout: { package: "package", items: { test_suites: "tests" } } });
    expect(read(path.join(dir, "cavelon.yaml"))).toContain(`tenant: acme  # Acme, ${tenant}\n`);
    expect(read(path.join(dir, "cavelon.yaml"))).not.toContain(token);
    for (const sub of ["package", "tests", "seeds", "env", ".cavelon"]) expect(statSync(path.join(dir, sub)).isDirectory(), sub).toBe(true);
    expect(parse(read(path.join(dir, "env", "test.yaml")))).toEqual({ harness: "support" });
    expect(existsSync(path.join(dir, "env", "prod.yaml"))).toBe(true);
    expect(read(path.join(dir, ".cavelon", ".gitignore"))).toMatch(/^\*$/m);
    expect(read(path.join(dir, ".gitignore"))).toMatch(/# cavelon:begin\n.*\n\.cavelon\/\n# cavelon:end/);
    const agents = read(path.join(dir, "AGENTS.md"));
    expect(agents).toMatch(/^<!-- cavelon:begin -->\n## Cavelon solution/);
    expect(agents.split("\n").filter((l) => l && !l.startsWith("<!--") && !l.startsWith("#")).length).toBeLessThanOrEqual(5);
    // No CLAUDE.md is made; Claude Code reads AGENTS.md when there is none.
    expect(existsSync(path.join(dir, "CLAUDE.md"))).toBe(false);
  });

  it("changes a customer's AGENTS.md, .gitignore and CLAUDE.md only between markers", async () => {
    const dir = folder();
    const agents = "# Our agents\n\nUse tabs, not spaces.\n";
    const gitignore = "node_modules/\r\n*.log\r\n";
    const claude = "Read the house rules first.\n";
    writeFileSync(path.join(dir, "AGENTS.md"), agents);
    writeFileSync(path.join(dir, ".gitignore"), gitignore);
    writeFileSync(path.join(dir, "CLAUDE.md"), claude);
    const first = await cli(sb, ["init", "--instance", server.url, "--tenant", tenant, "--json"], { cwd: dir });
    expect(first.code, first.stdout).toBe(0);
    const after = read(path.join(dir, "AGENTS.md"));
    expect(after.startsWith(agents)).toBe(true);
    expect(after.slice(agents.length)).toMatch(/^\n<!-- cavelon:begin -->\n[\s\S]*<!-- cavelon:end -->\n$/);
    expect(read(path.join(dir, ".gitignore"))).toBe(`${gitignore}\r\n# cavelon:begin\r\n# Local cavelon state (inventory, previews); never committed.\r\n.cavelon/\r\n# cavelon:end\r\n`);
    expect(read(path.join(dir, "CLAUDE.md"))).toBe(`${claude}\n<!-- cavelon:begin -->\n@AGENTS.md\n<!-- cavelon:end -->\n`);

    // The customer edits around the block; a second init changes nothing at all.
    writeFileSync(path.join(dir, "AGENTS.md"), `${read(path.join(dir, "AGENTS.md"))}\n## Ours again\n`);
    const before = read(path.join(dir, "AGENTS.md"));
    writeFileSync(path.join(dir, "env", "test.yaml"), "harness: mine\n");
    const second = await cli(sb, ["init", "--json"], { cwd: dir });
    expect(second.code).toBe(0);
    expect(second.json<{ files: Array<{ action: string }> }>().files.every((f) => f.action === "unchanged")).toBe(true);
    expect(read(path.join(dir, "AGENTS.md"))).toBe(before);
    expect(read(path.join(dir, "env", "test.yaml"))).toBe("harness: mine\n");
  });

  it.skipIf(process.platform === "win32")("keeps a CLAUDE.md symlink to AGENTS.md a symlink, and a file's permissions", async () => {
    const dir = folder();
    writeFileSync(path.join(dir, "AGENTS.md"), "# Ours\n", { mode: 0o600 });
    symlinkSync("AGENTS.md", path.join(dir, "CLAUDE.md"));
    const result = await cli(sb, ["init", "--instance", server.url, "--tenant", tenant], { cwd: dir });
    expect(result.code, result.stderr).toBe(0);
    expect(lstatSync(path.join(dir, "CLAUDE.md")).isSymbolicLink()).toBe(true);
    const agents = read(path.join(dir, "AGENTS.md"));
    expect(agents.match(/cavelon:begin/g)).toHaveLength(1);
    expect(agents).not.toContain("@AGENTS.md");
    expect(statSync(path.join(dir, "AGENTS.md")).mode & 0o777).toBe(0o600);
  });

  it("leaves a file with broken markers alone and says so", async () => {
    const dir = folder();
    const broken = "# Ours\n<!-- cavelon:begin -->\nhalf a block\n";
    writeFileSync(path.join(dir, "AGENTS.md"), broken);
    const result = await cli(sb, ["init", "--instance", server.url, "--tenant", tenant], { cwd: dir });
    expect(result.code).toBe(0);
    expect(read(path.join(dir, "AGENTS.md"))).toBe(broken);
    expect(result.stderr).toMatch(/warning: Left AGENTS.md as it is: its .* markers are not one well-formed pair/);
  });

  it("--agents writes the fallback skills and each agent's MCP entry, never over a customer's file", async () => {
    const dir = folder();
    mkdirSync(path.join(dir, ".cursor"), { recursive: true });
    writeFileSync(path.join(dir, ".cursor", "mcp.json"), `${JSON.stringify({ mcpServers: { other: { command: "x" } } }, null, 4)}\n`);
    mkdirSync(path.join(dir, ".vscode"), { recursive: true });
    const jsonc = '{\n  // our servers\n  "servers": {}\n}\n';
    writeFileSync(path.join(dir, ".vscode", "mcp.json"), jsonc);
    mkdirSync(path.join(dir, ".claude", "skills", "cavelon-loop"), { recursive: true });
    writeFileSync(path.join(dir, ".claude", "skills", "cavelon-loop", "SKILL.md"), "our own loop skill\n");

    const result = await onPlatform("linux", () =>
      cli(sb, ["init", "--instance", server.url, "--tenant", tenant, "--agents", "claude,codex,cursor", "--agents", "copilot", "--json"], { cwd: dir }),
    );
    expect(result.code, result.stdout).toBe(0);
    for (const root of [".agents/skills", ".claude/skills"]) {
      for (const skill of ["cavelon-loop", "cavelon-authoring", "cavelon-testing", "cavelon-long-running"]) {
        const file = path.join(dir, root, skill, "SKILL.md");
        if (root === ".claude/skills" && skill === "cavelon-loop") {
          expect(read(file)).toBe("our own loop skill\n");
          continue;
        }
        const text = read(file);
        expect(text, file).toMatch(new RegExp(`^---\\nname: ${skill}\\n`));
        expect(text).toContain("cavelon:generated");
      }
    }
    expect(JSON.parse(read(path.join(dir, ".mcp.json")))).toEqual({ mcpServers: { cavelon: { command: "npx", args: ["-y", "@cavelon/cli@0.1", "mcp"] } } });
    expect(read(path.join(dir, ".cursor", "mcp.json"))).toBe(
      '{\n    "mcpServers": {\n        "other": {\n            "command": "x"\n        },\n        "cavelon": {\n            "command": "npx",\n            "args": [\n                "-y",\n                "@cavelon/cli@0.1",\n                "mcp"\n            ]\n        }\n    }\n}\n',
    );
    expect(read(path.join(dir, ".vscode", "mcp.json"))).toBe(jsonc);
    expect(read(path.join(dir, ".codex", "config.toml"))).toBe(
      '# cavelon:begin\n[mcp_servers.cavelon]\ncommand = "npx"\nargs = ["-y", "@cavelon/cli@0.1", "mcp"]\n# cavelon:end\n',
    );
    const warnings = result.json<{ warnings: string[] }>().warnings.join("\n");
    expect(warnings).toMatch(/\.claude\/skills\/cavelon-loop\/SKILL\.md as it is: it was not written by cavelon/);
    expect(warnings).toMatch(/\.vscode\/mcp\.json as it is: it is not plain JSON .* add "servers\.cavelon"/);
  });

  it("refuses an unknown agent", async () => {
    const result = await cli(sb, ["init", "--agents", "clippy"], { cwd: folder() });
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/Unknown agent "clippy"/);
  });

  it("--update changes only the marked blocks and the fallback files it wrote", async () => {
    const dir = await initSolution(["--agents", "codex"]);
    const agentsFile = path.join(dir, "AGENTS.md");
    writeFileSync(agentsFile, `# Ours\n\n${read(agentsFile).replace("## Cavelon solution", "## An old block")}\nOurs after.\n`);
    const skill = path.join(dir, ".agents", "skills", "cavelon-testing", "SKILL.md");
    const current = read(skill);
    writeFileSync(skill, current.replace("# Testing and optimizing", "# An old version"));
    writeFileSync(path.join(dir, "env", "prod.yaml"), "tenant: prod-tenant\n");
    const projectBefore = read(path.join(dir, "cavelon.yaml"));

    const result = await cli(sb, ["init", "--update", "--json"], { cwd: dir });
    expect(result.code, result.stdout).toBe(0);
    const after = read(agentsFile);
    expect(after).toMatch(/^# Ours\n\n<!-- cavelon:begin -->\n## Cavelon solution/);
    expect(after).toMatch(/<!-- cavelon:end -->\n\nOurs after\.\n$/);
    expect(read(skill)).toBe(current);
    expect(read(path.join(dir, "env", "prod.yaml"))).toBe("tenant: prod-tenant\n");
    expect(read(path.join(dir, "cavelon.yaml"))).toBe(projectBefore);
    const files = result.json<{ files: Array<{ file: string; action: string }> }>().files;
    expect(files.filter((f) => f.action === "updated").map((f) => f.file).sort()).toEqual([".agents/skills/cavelon-testing/SKILL.md", "AGENTS.md"]);
    // It creates nothing that was not there.
    expect(existsSync(path.join(dir, "CLAUDE.md"))).toBe(false);
    expect(existsSync(path.join(dir, ".mcp.json"))).toBe(false);
  });

  it.runIf(gitAvailable())("--hook adds a pre-commit hook that runs validate, after a customer's shebang", async () => {
    const repo = folder("repo");
    gitIn(repo, "init", "-q");
    const hook = path.join(repo, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\nnpm test\nexit 0\n");
    const dir = path.join(repo, "solutions", "support");
    mkdirSync(dir, { recursive: true });
    const result = await cli(sb, ["init", "--instance", server.url, "--tenant", tenant, "--hook"], { cwd: dir });
    expect(result.code, result.stderr).toBe(0);
    const text = read(hook);
    expect(text).toMatch(/^#!\/bin\/sh\n# cavelon:begin\n# Check the Cavelon package[^\n]*\n[\s\S]*cd "\.\/solutions\/support\/" && \$cavelon_cmd validate[\s\S]*\n# cavelon:end\nnpm test\nexit 0\n$/);

    if (process.platform !== "win32") {
      // Only an invalid package stops the commit; a check that cannot run warns.
      const bin = path.join(repo, "fake-bin");
      mkdirSync(bin);
      writeFileSync(path.join(bin, "cavelon"), '#!/bin/sh\nexit "$FAKE_CODE"\n', { mode: 0o755 });
      writeFileSync(path.join(bin, "npm"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const runHook = (code: number) =>
        spawnSync("sh", [hook], { cwd: repo, env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, FAKE_CODE: String(code) }, encoding: "utf8" });
      expect(runHook(0).status).toBe(0);
      expect(runHook(3).status).toBe(1);
      const unable = runHook(1);
      expect(unable.status).toBe(0);
      expect(unable.stderr).toMatch(/cavelon validate could not run \(exit 1\)/);
    }

    const plain = folder("plain");
    const offered = await cli(sb, ["init", "--instance", server.url, "--tenant", tenant], { cwd: plain });
    expect(offered.stdout).toMatch(/cavelon init --hook/);
  });

  it.runIf(gitAvailable())("--hook leaves a hooks folder outside the repository alone, and uses one inside it", async () => {
    const shared = folder("shared-hooks");
    const repo = folder("repo");
    gitIn(repo, "init", "-q");
    // As a global core.hooksPath would: every repository of the user runs these hooks.
    gitIn(repo, "config", "core.hooksPath", shared);
    const result = await cli(sb, ["init", "--instance", server.url, "--tenant", tenant, "--hook", "--json"], { cwd: repo });
    expect(result.code, result.stderr).toBe(0);
    const hook = result.json<{ files: Array<{ file: string; action: string; reason?: string }> }>().files.find((f) => f.file.endsWith("pre-commit"));
    expect(hook).toMatchObject({ action: "skipped" });
    expect(hook!.reason).toMatch(/core\.hooksPath .* outside this repository/);
    expect(readdirSync(shared)).toEqual([]);

    // A hooks folder kept in the repository (as husky sets it) is the repository's own.
    gitIn(repo, "config", "core.hooksPath", ".githooks");
    const inside = await cli(sb, ["init", "--hook", "--json"], { cwd: repo });
    expect(inside.code, inside.stderr).toBe(0);
    expect(inside.json<{ files: Array<{ file: string; action: string }> }>().files).toContainEqual({ file: ".githooks/pre-commit", action: "created" });
    expect(read(path.join(repo, ".githooks", "pre-commit"))).toMatch(/^#!\/bin\/sh\n# cavelon:begin\n/);
  });

  it("--agents on native Windows starts npx through cmd /c, and --update keeps the other system's form", async () => {
    const dir = folder();
    const result = await onPlatform("win32", () => cli(sb, ["init", "--instance", server.url, "--tenant", tenant, "--agents", "claude,codex", "--json"], { cwd: dir }));
    expect(result.code, result.stdout).toBe(0);
    const windows = { command: "cmd", args: ["/c", "npx", "-y", "@cavelon/cli@0.1", "mcp"] };
    expect(JSON.parse(read(path.join(dir, ".mcp.json")))).toEqual({ mcpServers: { cavelon: windows } });
    expect(read(path.join(dir, ".codex", "config.toml"))).toContain('command = "cmd"\nargs = ["/c", "npx", "-y", "@cavelon/cli@0.1", "mcp"]');

    // Whoever is on the other system does not rewrite the entry someone wrote on theirs.
    const posix = `${JSON.stringify({ mcpServers: { cavelon: { command: "npx", args: ["-y", "@cavelon/cli@0.1", "mcp"] } } }, null, 2)}\n`;
    writeFileSync(path.join(dir, ".mcp.json"), posix);
    const toml = read(path.join(dir, ".codex", "config.toml"));
    const updated = await onPlatform("win32", () => cli(sb, ["init", "--update", "--json"], { cwd: dir }));
    expect(updated.code, updated.stdout).toBe(0);
    expect(read(path.join(dir, ".mcp.json"))).toBe(posix);
    const onLinux = await onPlatform("linux", () => cli(sb, ["init", "--update", "--json"], { cwd: dir }));
    expect(onLinux.code, onLinux.stdout).toBe(0);
    expect(read(path.join(dir, ".codex", "config.toml"))).toBe(toml);
  });

  it("--update keeps an entry changed to start the installed cavelon", async () => {
    const dir = folder();
    const result = await cli(sb, ["init", "--instance", server.url, "--tenant", tenant, "--agents", "claude,codex,copilot", "--json"], { cwd: dir });
    expect(result.code, result.stdout).toBe(0);
    const claude = `${JSON.stringify({ mcpServers: { cavelon: { command: "cavelon", args: ["mcp"] } } }, null, 2)}\n`;
    const copilot = `${JSON.stringify({ servers: { cavelon: { type: "stdio", command: "cavelon", args: ["mcp"] } } }, null, 2)}\n`;
    writeFileSync(path.join(dir, ".mcp.json"), claude);
    writeFileSync(path.join(dir, ".vscode", "mcp.json"), copilot);
    const toml = read(path.join(dir, ".codex", "config.toml")).replace(/command = "[^"]*"\nargs = \[[^\]]*\]/, 'command = "cavelon"\nargs = ["mcp"]');
    expect(toml).toContain('command = "cavelon"\nargs = ["mcp"]');
    writeFileSync(path.join(dir, ".codex", "config.toml"), toml);

    const updated = await cli(sb, ["init", "--update", "--json"], { cwd: dir });
    expect(updated.code, updated.stdout).toBe(0);
    expect(read(path.join(dir, ".mcp.json"))).toBe(claude);
    expect(read(path.join(dir, ".vscode", "mcp.json"))).toBe(copilot);
    expect(read(path.join(dir, ".codex", "config.toml"))).toBe(toml);
  });

  it("needs an instance and a login, and never prompts", async () => {
    const bare = sandbox();
    try {
      const result = await cli(bare, ["init", "--json"], { cwd: bare.home });
      expect(result.code).toBe(2);
      expect(result.json<{ error: { code: string } }>().error.code).toBe("no_instance");
      expect(existsSync(path.join(bare.home, "cavelon.yaml"))).toBe(false);
    } finally {
      bare.cleanup();
    }
  });
});

describe("init --from", () => {
  // A real blueprint export: a Masterloop parent that counts, without a Sandbox.
  const BLUEPRINT = path.join(__dirname, "fixtures", "blueprint-counter-parent.json");
  const blueprint = () => JSON.parse(read(BLUEPRINT)) as Record<string, unknown>;

  /** A copy of the blueprint inside the sandbox, as a developer would have it next to the solution. */
  function blueprintCopy(dir: string, name = "counter-parent.json"): string {
    const file = path.join(dir, name);
    copyFileSync(BLUEPRINT, file);
    return file;
  }

  it("writes a package export into package/ and tests/ as pull does, and an offline validate takes it from there", async () => {
    const dir = folder();
    writeFileSync(path.join(dir, "AGENTS.md"), "# Our agents\n\nUse tabs.\n");
    blueprintCopy(sb.home, "counter-parent.json");
    const result = await cli(sb, ["init", "--instance", server.url, "--tenant", tenant, "--from", "../counter-parent.json", "--json"], { cwd: dir });
    expect(result.code, result.stderr + result.stdout).toBe(0);
    const data = result.json<{ imported: { files: { written: string[]; removed: string[] }; ignored: string[]; package_version: string }; next: string[] }>();
    // The blueprint holds no persona: its file shows every field as a placeholder.
    expect(data.imported.files.written).toEqual([
      "package/harnesses.yaml",
      "package/manifest.yaml",
      "package/persona.yaml",
      "package/registry_entities.yaml",
      "package/runtime_requirements.yaml",
      "tests/counter-loop.yaml",
    ]);
    expect(data.imported).toMatchObject({ ignored: [], package_version: "v3", files: { removed: [] } });
    expect(data.next.slice(0, 2)).toEqual(["Check it offline: cavelon validate", "Preview it on the instance: cavelon apply --env test"]);

    // Each section holds the export's value, the suite one file of its own.
    const pkg = blueprint();
    for (const section of ["manifest", "harnesses", "registry_entities", "runtime_requirements"]) {
      expect(parse(read(path.join(dir, "package", `${section}.yaml`))), section).toEqual(pkg[section]);
    }
    expect(parse(read(path.join(dir, "tests", "counter-loop.yaml")))).toEqual((pkg.test_suites as unknown[])[0]);
    // The folder holds the package's only harness; the kit's marked block sits after the customer's text.
    expect(parse(read(path.join(dir, "cavelon.yaml")))).toMatchObject({ harness: "blueprint-counter", package_version: "v3" });
    expect(parse(read(path.join(dir, "env", "test.yaml")))).toEqual({ harness: "blueprint-counter" });
    expect(read(path.join(dir, "AGENTS.md"))).toMatch(/^# Our agents\n\nUse tabs\.\n\n<!-- cavelon:begin -->\n## Cavelon solution[\s\S]*<!-- cavelon:end -->\n$/);

    server.state.requests.length = 0;
    const valid = await cli(sb, ["validate", "--offline", "--json"], { cwd: dir });
    expect(valid.code, valid.stdout).toBe(0);
    expect(valid.json()).toMatchObject({ valid: true, schema_version: "v3", errors: 0, warning_count: 0, warnings: [], sections: 5 });
    expect(server.state.requests).toEqual([]);

    // The same file again changes nothing.
    const again = await cli(sb, ["init", "--from", "../counter-parent.json", "--json"], { cwd: dir });
    expect(again.code, again.stdout).toBe(0);
    expect(again.json<{ imported: { files: { written: string[]; unchanged: string[] } } }>().imported.files).toMatchObject({ written: [] });

    // init created the draft the package holds, under the package's harness name; apply previews into it.
    expect(result.stderr).toContain("Created the draft solution Blueprint: sandbox-free counter (blueprint-counter).");
    expect(server.state.harnesses.find((h) => h.slug === "blueprint-counter")).toMatchObject({ name: "Blueprint: sandbox-free counter", status: "draft" });
    const applied = await cli(sb, ["apply", "--env", "test", "--json"], { cwd: dir });
    expect(applied.code, applied.stdout).toBe(0);
  });

  it("refuses to change or remove a package file that holds something else, unless --force", async () => {
    const dir = await initSolution();
    expect((await cli(sb, ["pull"], { cwd: dir })).code).toBe(0);
    const harnesses = read(path.join(dir, "package", "harnesses.yaml"));
    const file = blueprintCopy(dir);
    const refused = await cli(sb, ["init", "--from", file, "--json"], { cwd: dir });
    expect(refused.code).toBe(4);
    const error = refused.json<{ error: { code: string; details: { files: string[] }; hint: string } }>().error;
    expect(error).toMatchObject({ code: "package_files_differ" });
    expect(error.hint).toMatch(/--force/);
    // The pulled sample's files would change (harnesses, manifest) or go away (agents, the suites).
    expect(error.details.files).toEqual(expect.arrayContaining(["package/harnesses.yaml", "package/agents.yaml", "tests/smoke.yaml", "tests/refusals.yaml"]));
    expect(read(path.join(dir, "package", "harnesses.yaml"))).toBe(harnesses);
    expect(parse(read(path.join(dir, "package", "registry_entities.yaml")))).toEqual({});
    expect(existsSync(path.join(dir, "tests", "counter-loop.yaml"))).toBe(false);

    const forced = await cli(sb, ["init", "--from", file, "--force", "--json"], { cwd: dir });
    expect(forced.code, forced.stdout).toBe(0);
    expect(parse(read(path.join(dir, "package", "harnesses.yaml")))).toEqual(blueprint().harnesses);
    expect(existsSync(path.join(dir, "package", "agents.yaml"))).toBe(false);
    expect(readdirSync(path.join(dir, "tests")).filter((f) => f !== ".gitkeep")).toEqual(["counter-loop.yaml"]);
    // The folder already named its solution; the package does not rename it.
    expect(parse(read(path.join(dir, "cavelon.yaml"))).harness).toBe("support");
  });

  it("reports sections the instance's schema does not know as ignored, and reads a YAML export", async () => {
    const dir = folder();
    const yamlFile = path.join(dir, "blueprint.yaml");
    writeFileSync(yamlFile, stringify({ ...blueprint(), future_widgets: { widgets: ["a"] } }));
    const result = await cli(sb, ["init", "--instance", server.url, "--tenant", tenant, "--from", "blueprint.yaml", "--json"], { cwd: dir });
    expect(result.code, result.stdout).toBe(0);
    const data = result.json<{ imported: { ignored: string[]; files: { written: string[] } }; warnings: string[] }>();
    expect(data.imported.ignored).toEqual(["future_widgets"]);
    expect(data.imported.files.written).toContain("package/future_widgets.yaml");
    expect(data.warnings.join("\n")).toMatch(/no section "future_widgets"; .* the instance ignores it/);
    const text = await cli(sb, ["init", "--from", "blueprint.yaml"], { cwd: dir });
    expect(text.stdout).toMatch(/ignored\s+future_widgets \(not in this instance's package schema\)/);

    const valid = await cli(sb, ["validate", "--offline", "--json"], { cwd: dir });
    expect(valid.code).toBe(0);
    expect(valid.json<{ findings: Array<{ code: string; path: string }> }>().findings).toEqual([
      expect.objectContaining({ code: "package_section_unknown", path: "future_widgets" }),
    ]);
  });

  it("refuses a missing or malformed file before it writes anything", async () => {
    const dir = folder();
    const missing = await cli(sb, ["init", "--instance", server.url, "--tenant", tenant, "--from", "nope.json", "--json"], { cwd: dir });
    expect(missing.code).toBe(2);
    expect(missing.json<{ error: { message: string } }>().error.message).toMatch(/No file nope\.json/);
    writeFileSync(path.join(dir, "list.json"), "[1, 2]");
    const list = await cli(sb, ["init", "--instance", server.url, "--tenant", tenant, "--from", "list.json", "--json"], { cwd: dir });
    expect(list.code).toBe(2);
    expect(list.json<{ error: { code: string } }>().error.code).toBe("package_import_invalid");
    writeFileSync(path.join(dir, "broken.json"), "{ not json");
    expect((await cli(sb, ["init", "--instance", server.url, "--tenant", tenant, "--from", "broken.json"], { cwd: dir })).code).toBe(2);
    expect(existsSync(path.join(dir, "cavelon.yaml"))).toBe(false);
    expect((await cli(sb, ["init", "--update", "--from", "list.json"], { cwd: dir })).code).toBe(2);
    expect((await cli(sb, ["init", "--force"], { cwd: dir })).code).toBe(2);
  });
});

describe("pull", () => {
  it("writes the package split along the schema's sections, the tests one file per suite, and the inventory", async () => {
    const dir = await initSolution();
    const result = await cli(sb, ["pull", "--json"], { cwd: dir });
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const files = readdirSync(path.join(dir, "package")).filter((f) => f !== ".gitkeep").sort();
    expect(files).toContain("agents.yaml");
    expect(files).toContain("manifest.yaml");
    expect(files).not.toContain("test_suites.yaml");
    expect(readdirSync(path.join(dir, "tests")).filter((f) => f !== ".gitkeep").sort()).toEqual(["refusals.yaml", "smoke.yaml"]);
    const agents = parse(read(path.join(dir, "package", "agents.yaml")));
    expect(agents[0]).toMatchObject({ slug: "helper", system_prompt: "Answer from the handbook.\nSay when you do not know." });
    expect(read(path.join(dir, "package", "agents.yaml"))).toMatch(/system_prompt: \|-?\n\s+Answer from the handbook\./);
    const inventory = read(path.join(dir, ".cavelon", "inventory.md"));
    expect(inventory).toMatch(/## Solutions[\s\S]*support/);
    const record = JSON.parse(read(path.join(dir, ".cavelon", "pull.json")));
    expect(record).toMatchObject({ harness: { slug: "support" }, scope: "agent_graph", package_version: "v3" });
    const exported = server.state.requests.filter((r) => r.path === "/api/v1/agent-graph/export").pop()!;
    expect(exported.query.get("scope")).toBe("agent_graph");
    expect(exported.query.get("harness_id")).toMatch(/^[0-9a-f-]{36}$/);

    // Nothing changed on the instance: a second pull rewrites nothing, not even the manifest's export time.
    const manifest = read(path.join(dir, "package", "manifest.yaml"));
    const again = await cli(sb, ["pull", "--json", "--force"], { cwd: dir });
    expect(again.json<{ files: { written: string[] } }>().files.written).toEqual([]);
    expect(read(path.join(dir, "package", "manifest.yaml"))).toBe(manifest);
  });

  it("keeps a section the schema does not know byte for byte", async () => {
    const dir = await initSolution();
    await cli(sb, ["pull"], { cwd: dir });
    const future = "# written by a newer kit\nwidgets:   [a, b]   # odd spacing kept\n";
    writeFileSync(path.join(dir, "package", "future_widgets.yaml"), future);
    const result = await cli(sb, ["pull", "--force"], { cwd: dir });
    expect(result.code).toBe(0);
    expect(read(path.join(dir, "package", "future_widgets.yaml"))).toBe(future);
    expect(result.stderr).toMatch(/Kept package\/future_widgets\.yaml/);
  });

  it.runIf(gitAvailable())("refuses to overwrite uncommitted changes, and a second pull after an Admin edit shows the change in git", async () => {
    const dir = await initSolution();
    gitIn(dir, "init", "-q");
    expect((await cli(sb, ["pull"], { cwd: dir })).code).toBe(0);
    gitIn(dir, "add", "-A");
    gitIn(dir, "commit", "-qm", "first pull");
    expect(gitIn(dir, "status", "--porcelain")).toBe("");

    server.editConfig(tenant, (pkg) => {
      (pkg.agents as Array<Record<string, unknown>>)[0]!.temperature = 0.7;
    });
    const pulled = await cli(sb, ["pull"], { cwd: dir });
    expect(pulled.code, pulled.stderr).toBe(0);
    expect(pulled.stdout).toMatch(/written\s+package\/agents\.yaml/);
    const changed = gitIn(dir, "status", "--porcelain").split("\n").filter(Boolean).map((l) => l.slice(3)).sort();
    expect(changed).toEqual(["package/agents.yaml", "package/manifest.yaml"]);
    expect(gitIn(dir, "diff", "--", "package/agents.yaml")).toMatch(/-\s+temperature: 0\.2\n\+\s+temperature: 0\.7/);

    // The agent's own unpushed edit is not lost silently.
    writeFileSync(path.join(dir, "package", "agents.yaml"), read(path.join(dir, "package", "agents.yaml")).replace("0.7", "0.9"));
    const refused = await cli(sb, ["pull", "--json"], { cwd: dir });
    expect(refused.code).toBe(4);
    expect(refused.json<{ error: { code: string } }>().error.code).toBe("uncommitted_changes");
    expect(read(path.join(dir, "package", "agents.yaml"))).toContain("0.9");
  });

  it("outside git, refuses to overwrite a local edit or remove a file the last pull did not write, unless --force", async () => {
    const dir = await initSolution();
    const agentsFile = path.join(dir, "package", "agents.yaml");
    const draft = path.join(dir, "tests", "draft.yaml");
    expect((await cli(sb, ["pull"], { cwd: dir })).code).toBe(0);
    const setTemperature = (value: number) =>
      server.editConfig(tenant, (pkg) => {
        (pkg.agents as Array<Record<string, unknown>>)[0]!.temperature = value;
      });

    // Files as the last pull left them: an Admin edit comes in without --force.
    setTemperature(0.7);
    const taken = await cli(sb, ["pull"], { cwd: dir });
    expect(taken.code, taken.stderr).toBe(0);
    expect(read(agentsFile)).toContain("temperature: 0.7");

    // A local edit and a suite that was never applied are not lost silently.
    writeFileSync(agentsFile, read(agentsFile).replace("0.7", "0.9"));
    writeFileSync(draft, stringify({ name: "Draft", cases: [] }));
    setTemperature(0.5);
    const refused = await cli(sb, ["pull", "--json"], { cwd: dir });
    expect(refused.code).toBe(4);
    const error = refused.json<{ error: { code: string; message: string; details: { files: string[] } } }>().error;
    expect(error).toMatchObject({ code: "uncommitted_changes", details: { files: ["package/agents.yaml", "tests/draft.yaml"] } });
    expect(error.message).toMatch(/not in a git repository/);
    expect(read(agentsFile)).toContain("temperature: 0.9");
    expect(existsSync(draft)).toBe(true);

    const forced = await cli(sb, ["pull", "--force"], { cwd: dir });
    expect(forced.code, forced.stderr).toBe(0);
    expect(read(agentsFile)).toContain("temperature: 0.5");
    expect(existsSync(draft)).toBe(false);
  });

  it.runIf(gitAvailable())("pull after apply in a repository without a commit: files as the last pull or apply left them are not refused", async () => {
    // The solution sits in a subfolder of the repository, so git names its files with a prefix.
    const repo = folder("repo");
    gitIn(repo, "init", "-q");
    const dir = path.join(repo, "solution");
    mkdirSync(dir);
    expect((await cli(sb, ["init", "--instance", server.url, "--tenant", tenant, "--harness", "support"], { cwd: dir })).code).toBe(0);
    expect((await cli(sb, ["pull"], { cwd: dir })).code).toBe(0);
    // Nothing was committed: every pulled file is untracked, and the next pull still takes the instance's.
    const again = await cli(sb, ["pull"], { cwd: dir });
    expect(again.code, again.stderr).toBe(0);

    // A local edit that is neither committed nor applied is refused, by its path inside the solution.
    const agentsFile = path.join(dir, "package", "agents.yaml");
    writeFileSync(agentsFile, read(agentsFile).replace("temperature: 0.2", "temperature: 0.6"));
    const refused = await cli(sb, ["pull", "--json"], { cwd: dir });
    expect(refused.code).toBe(4);
    expect(refused.json<{ error: { details: { files: string[] } } }>().error.details.files).toEqual(["package/agents.yaml"]);

    // Once applied, the instance holds it: pull goes ahead without --force, and keeps the edit the instance now has.
    const preview = (await cli(sb, ["apply", "--json"], { cwd: dir })).json<{ preview_id: string }>();
    expect((await cli(sb, ["apply", "--confirm", preview.preview_id], { cwd: dir })).code).toBe(0);
    const afterApply = await cli(sb, ["pull"], { cwd: dir });
    expect(afterApply.code, afterApply.stderr + afterApply.stdout).toBe(0);
    expect(read(agentsFile)).toContain("temperature: 0.6");

    // A later edit is refused again.
    writeFileSync(agentsFile, read(agentsFile).replace("temperature: 0.6", "temperature: 0.9"));
    const later = await cli(sb, ["pull", "--json"], { cwd: dir });
    expect(later.code).toBe(4);
    expect(later.json<{ error: { details: { files: string[] } } }>().error.details.files).toEqual(["package/agents.yaml"]);
  });

  it("outside git, a file an apply imported counts as the instance's, so pull replaces it without --force", async () => {
    const dir = await initSolution();
    expect((await cli(sb, ["pull"], { cwd: dir })).code).toBe(0);
    const suite = path.join(dir, "tests", "smoke.yaml");
    writeFileSync(suite, stringify({ name: "Smoke", cases: [] }));
    const preview = (await cli(sb, ["apply", "--json"], { cwd: dir })).json<{ preview_id: string }>();
    expect((await cli(sb, ["apply", "--confirm", preview.preview_id], { cwd: dir })).code).toBe(0);
    const pulled = await cli(sb, ["pull"], { cwd: dir });
    expect(pulled.code, pulled.stderr + pulled.stdout).toBe(0);
  });

  it("refuses to overwrite package files outside git when no earlier pull recorded them", async () => {
    const dir = await initSolution();
    expect((await cli(sb, ["pull"], { cwd: dir })).code).toBe(0);
    // An older kit's pull recorded which files it wrote, not their content.
    rmSync(path.join(dir, ".cavelon", "pulled-files.json"));
    server.editConfig(tenant, (pkg) => {
      (pkg.agents as Array<Record<string, unknown>>)[0]!.temperature = 0.4;
    });
    const refused = await cli(sb, ["pull", "--json"], { cwd: dir });
    expect(refused.code).toBe(4);
    // The manifest, rewritten with any change, counts as well: nothing tells it from an edit.
    expect(refused.json<{ error: { details: { files: string[] } } }>().error.details.files).toEqual(["package/agents.yaml", "package/manifest.yaml"]);
  });

  it.skipIf(process.platform === "win32")("reads a symlinked package file and writes through the link; a link out of the solution is an error", async () => {
    const dir = await initSolution();
    expect((await cli(sb, ["pull"], { cwd: dir })).code).toBe(0);
    const { sections } = (await cli(sb, ["validate", "--offline", "--json"], { cwd: dir })).json<{ sections: number }>();
    const shared = path.join(dir, "shared");
    mkdirSync(shared);
    const agentsFile = path.join(dir, "package", "agents.yaml");
    copyFileSync(agentsFile, path.join(shared, "agents.yaml"));
    rmSync(agentsFile);
    symlinkSync(path.join("..", "shared", "agents.yaml"), agentsFile);

    const valid = await cli(sb, ["validate", "--offline", "--json"], { cwd: dir });
    expect(valid.code, valid.stdout).toBe(0);
    expect(valid.json()).toMatchObject({ valid: true, sections });
    const applied = await cli(sb, ["apply", "--env", "test", "--json"], { cwd: dir });
    expect(applied.code, applied.stdout).toBe(0);
    const preview = server.state.requests.filter((r) => r.path === "/api/v1/agent-graph/import/preview").pop()!;
    expect(Object.keys((preview.body as { package: Record<string, unknown> }).package)).toContain("agents");

    server.editConfig(tenant, (pkg) => {
      (pkg.agents as Array<Record<string, unknown>>)[0]!.temperature = 0.6;
    });
    expect((await cli(sb, ["pull"], { cwd: dir })).code).toBe(0);
    expect(lstatSync(agentsFile).isSymbolicLink()).toBe(true);
    expect(read(path.join(shared, "agents.yaml"))).toContain("temperature: 0.6");

    // A link that leads out of the solution is neither read nor sent.
    const outside = path.join(sb.home, `outside-${dirCount}.yaml`);
    writeFileSync(outside, "- name: elsewhere\n");
    symlinkSync(outside, path.join(dir, "tests", "elsewhere.yaml"));
    const refused = await cli(sb, ["validate", "--offline", "--json"], { cwd: dir });
    expect(refused.code).toBe(3);
    const findings = refused.json<{ findings: Array<{ code: string; file: string; message: string }> }>().findings;
    expect(findings).toContainEqual(expect.objectContaining({ code: "package_file_invalid", file: "tests/elsewhere.yaml" }));
  });

  it("never writes outside package/ whatever section names the instance sends", async () => {
    const dir = await initSolution();
    server.editConfig(tenant, (pkg) => {
      pkg["../escaped"] = { x: 1 };
      pkg[".hidden"] = { x: 1 };
    });
    const result = await cli(sb, ["pull", "--json"], { cwd: dir });
    expect(result.code).toBe(0);
    expect(result.json<{ files: { refused: string[] } }>().files.refused.sort()).toEqual(["../escaped", ".hidden"].sort());
    expect(existsSync(path.join(dir, "escaped.yaml"))).toBe(false);
    expect(readdirSync(path.join(dir, "package")).filter((f) => f.includes("escaped") || f.startsWith(".hidden"))).toEqual([]);
    expect(result.stderr + result.stdout).toMatch(/Did not write section "\.\.\/escaped"/);
  });

  it("outside a solution says how to start one", async () => {
    const result = await cli(sb, ["pull", "--json"], { cwd: folder() });
    expect(result.code).toBe(2);
    expect(result.json<{ error: { code: string; hint: string } }>().error).toMatchObject({ code: "no_solution" });
  });
});

describe("validate", () => {
  it("passes a pulled package offline, and reports an edit error with file, line and code", async () => {
    const dir = await initSolution();
    await cli(sb, ["pull"], { cwd: dir });
    server.state.requests.length = 0;
    const ok = await cli(sb, ["validate", "--offline", "--json"], { cwd: dir });
    expect(ok.code, ok.stdout).toBe(0);
    expect(ok.json()).toMatchObject({ valid: true, schema_version: "v3", errors: 0 });
    expect(server.state.requests).toEqual([]);

    const agentsFile = path.join(dir, "package", "agents.yaml");
    writeFileSync(agentsFile, read(agentsFile).replace("temperature: 0.2", 'temperature: "warm"'));
    writeFileSync(path.join(dir, "tests", "smoke.yaml"), read(path.join(dir, "tests", "smoke.yaml")).replace(/^name: Smoke\n/m, ""));
    const bad = await cli(sb, ["validate", "--offline", "--json"], { cwd: dir });
    expect(bad.code).toBe(3);
    const findings = bad.json<{ findings: Array<{ code: string; file: string; line: number; path: string; message: string }> }>().findings;
    const temperature = findings.find((f) => f.path === "agents[0].temperature")!;
    expect(temperature).toMatchObject({ code: "package_schema_invalid", file: "package/agents.yaml" });
    expect(read(agentsFile).split("\n")[temperature.line - 1]).toMatch(/temperature: "warm"/);
    expect(findings.find((f) => f.file === "tests/smoke.yaml")).toMatchObject({ message: 'missing required field "name"' });

    const text = await cli(sb, ["validate", "--offline"], { cwd: dir });
    expect(text.stdout).toMatch(/error package_schema_invalid {2}package\/agents\.yaml:\d+ agents\[0\]\.temperature: must be number/);
  });

  it("reads package files saved with a byte-order mark and CRLF line ends", async () => {
    const dir = await initSolution();
    await cli(sb, ["pull"], { cwd: dir });
    const { sections } = (await cli(sb, ["validate", "--offline", "--json"], { cwd: dir })).json<{ sections: number }>();
    const agentsFile = path.join(dir, "package", "agents.yaml");
    writeFileSync(agentsFile, `\uFEFF${read(agentsFile).replace(/\n/g, "\r\n")}`);
    const harnessesFile = path.join(dir, "package", "harnesses.yaml");
    writeFileSync(path.join(dir, "package", "harnesses.json"), `\uFEFF${JSON.stringify(parse(read(harnessesFile)), null, 2)}\n`);
    rmSync(harnessesFile);
    const result = await cli(sb, ["validate", "--offline", "--json"], { cwd: dir });
    expect(result.code, result.stdout).toBe(0);
    expect(result.json()).toMatchObject({ valid: true, sections });

    // pull sees the same values and leaves the bytes as they are.
    const before = read(agentsFile);
    const pulled = await cli(sb, ["pull", "--json"], { cwd: dir });
    expect(pulled.code, pulled.stdout).toBe(0);
    expect(pulled.json<{ files: { written: string[] } }>().files.written).toEqual([]);
    expect(read(agentsFile)).toBe(before);
  });

  it("warns about a solution with no package files yet, and apply asks for a pull", async () => {
    const dir = await initSolution();
    const validated = await cli(sb, ["validate", "--offline"], { cwd: dir });
    expect(validated.stderr).toMatch(/No package files in package\/ yet; `cavelon pull`/);
    const applied = await cli(sb, ["apply", "--env", "test", "--json"], { cwd: dir });
    expect(applied.code).toBe(2);
    expect(applied.json<{ error: { message: string; hint: string } }>().error).toMatchObject({ message: "No package files in package/." });

    // The empty tests/ init made does not clash with suites kept in package/.
    writeFileSync(path.join(dir, "package", "test_suites.yaml"), "[]\n");
    const kept = await cli(sb, ["validate", "--offline", "--json"], { cwd: dir });
    expect(kept.json<{ findings: Array<{ code: string }> }>().findings.map((f) => f.code)).not.toContain("package_file_duplicate");
  });

  it("warns about a section the schema does not know, and refuses a version the instance does not accept", async () => {
    const dir = await initSolution();
    await cli(sb, ["pull"], { cwd: dir });
    writeFileSync(path.join(dir, "package", "deployment_notes.yaml"), "owner: ops\n");
    const warned = await cli(sb, ["validate", "--json"], { cwd: dir });
    expect(warned.code).toBe(0);
    expect(warned.json<{ findings: Array<{ code: string; severity: string }> }>().findings).toEqual([
      expect.objectContaining({ code: "package_section_unknown", severity: "warning" }),
    ]);

    writeFileSync(path.join(dir, "package", "manifest.yaml"), read(path.join(dir, "package", "manifest.yaml")).replace("package_version: v3", "package_version: v9"));
    const refused = await cli(sb, ["validate", "--offline", "--json"], { cwd: dir });
    expect(refused.code).toBe(1);
    expect(refused.json<{ error: { code: string } }>().error.code).toBe("package_schema_unavailable");
  });

  it("warns, never fails, on a max_concurrency above the branch width and on branches that run in sequence", async () => {
    const dir = await initSolution();
    await cli(sb, ["pull"], { cwd: dir });
    writeFileSync(
      path.join(dir, "package", "registry_entities.yaml"),
      [
        "orchestration_nodes:",
        "  - slug: review-sections",
        "    node_type: for_each_item",
        "    harness_slug: support",
        "    config:",
        "      source: $.sections",
        "      mode: map",
        "      max_concurrency: 12",
        "",
      ].join("\n"),
    );
    const capped = await cli(sb, ["validate", "--json"], { cwd: dir });
    expect(capped.code, capped.stdout).toBe(0);
    const findings = capped.json<{ valid: boolean; findings: Array<{ code: string; severity: string; file: string; line: number; message: string; hint: string }> }>();
    expect(findings.valid).toBe(true);
    expect(findings.findings).toEqual([
      expect.objectContaining({ code: "branch_width_capped", severity: "warning", file: "package/registry_entities.yaml", line: 8 }),
    ]);
    expect(findings.findings[0]!.message).toBe(
      'The node "review-sections" sets max_concurrency 12, above this instance\'s branch width of 8 (ORCHESTRATION_MAX_BRANCH_CONCURRENCY): it runs at most 8 branches at once.',
    );

    // The tenant's flag is turned off; validate reads the limits the instance last published (here from `cavelon limits`), offline.
    server.state.tenantFlags.set(tenant, new Map([["ORCHESTRATION_PARALLEL_FANOUT_ENABLED", false]]));
    await cli(sb, ["limits"], { cwd: dir });
    const sequential = await cli(sb, ["validate", "--offline"], { cwd: dir });
    expect(sequential.code, sequential.stdout).toBe(0);
    expect(sequential.stdout).toMatch(/warning branches_run_in_sequence {2}package\/registry_entities\.yaml:\d+ registry_entities\.orchestration_nodes\[0\]\.config: This tenant runs fan-outs and Map loops in sequence, so the node "review-sections" runs one branch after another \(same result, slower\): feature_flags\.ORCHESTRATION_PARALLEL_FANOUT_ENABLED is off/);
    expect(sequential.stdout).toMatch(/Valid against package schema v3 \(\d+ sections, 2 warnings\)\./);
    const explained = await cli(sb, ["explain", "branches_run_in_sequence"], { cwd: dir });
    expect(explained.stdout).toMatch(/cavelon limits --key orchestration_parallel_branches/);
    server.state.tenantFlags.clear();
  });

  it("finds broken references, unknown fields and unknown models offline, one finding each with file and line", async () => {
    server.state.models.push(modelRow(tenant, { model_id: "gpt-4.1" }));
    try {
      const dir = await initSolution();
      expect((await cli(sb, ["pull"], { cwd: dir })).code).toBe(0);
      const inventory = JSON.parse(read(path.join(dir, ".cavelon", "inventory.json"))) as { names: Record<string, string[] | null> };
      expect(inventory.names).toMatchObject({ solutions: expect.arrayContaining(["support"]), skills: ["faq"], models: ["gpt-4.1"], tools: [], knowledge_bases: [] });
      expect((await cli(sb, ["validate", "--offline", "--json"], { cwd: dir })).json()).toMatchObject({ valid: true, warning_count: 0 });

      const skillsFile = path.join(dir, "package", "skills.yaml");
      const agentsFile = path.join(dir, "package", "agents.yaml");
      const skills = parse(read(skillsFile)) as Array<Record<string, unknown>>;
      skills.push({ slug: "faq", name: "FAQ again", knowledge_base_assignments: [{ knowledge_base_name: "Handbok" }] });
      writeFileSync(skillsFile, stringify(skills));
      const agents = parse(read(agentsFile)) as Array<Record<string, unknown>>;
      Object.assign(agents[0]!, {
        temprature: 0.9,
        llm_model: "gpt-9-ultra",
        harness_slug: "suport",
        skill_assignments: [{ skill_slug: "fqa" }],
        tool_assignments: [{ tool_slug: "crn" }],
        handoffs: [{ to_agent_slug: "billing" }, { target_agent_slug: "helper" }],
      });
      writeFileSync(agentsFile, stringify(agents));

      const result = await cli(sb, ["validate", "--offline", "--json"], { cwd: dir });
      expect(result.code, result.stdout).toBe(3);
      type Found = { code: string; severity: string; file: string; line: number; path: string; message: string; suggestion?: string };
      const findings = result.json<{ findings: Found[] }>().findings;
      const lineOf = (f: Found) => read(path.join(dir, f.file)).split("\n")[f.line - 1];
      const one = (code: string, at: string) => {
        const found = findings.filter((f) => f.code === code && f.path === at);
        expect(found, `${code} at ${at}: ${JSON.stringify(findings, null, 1)}`).toHaveLength(1);
        return found[0]!;
      };

      const duplicate = one("package_duplicate_key", "skills[1].slug");
      expect(duplicate).toMatchObject({ severity: "error", file: "package/skills.yaml" });
      expect(duplicate.message).toMatch(/^Two skills have the slug "faq" \(also package\/skills\.yaml:\d+\); the import keeps one of them\.$/);
      expect(lineOf(duplicate)).toMatch(/slug: faq/);

      const kb = one("package_reference_unknown", "skills[1].knowledge_base_assignments[0].knowledge_base_name");
      expect(kb).toMatchObject({ severity: "warning", file: "package/skills.yaml", suggestion: "Handbook" });
      expect(kb.message).toMatch(/^The skill "faq" names the knowledge base "Handbok", which is neither in the package nor among the tenant's knowledge bases at the last pull \(.+\)\. Did you mean "Handbook"\?$/);
      expect(lineOf(kb)).toMatch(/knowledge_base_name: Handbok/);

      expect(one("package_reference_unknown", "agents[0].skill_assignments[0].skill_slug")).toMatchObject({ file: "package/agents.yaml", suggestion: "faq" });
      expect(one("package_reference_unknown", "agents[0].tool_assignments[0].tool_slug")).toMatchObject({ suggestion: "crm" });
      expect(one("package_reference_unknown", "agents[0].harness_slug")).toMatchObject({ suggestion: "support" });

      const handoff = one("package_reference_missing", "agents[0].handoffs[0].to_agent_slug");
      expect(handoff).toMatchObject({ severity: "error", file: "package/agents.yaml" });
      expect(handoff.message).toBe('The agent "helper" hands off to the agent "billing", which is not in the package.');
      expect(lineOf(handoff)).toMatch(/to_agent_slug: billing/);

      const field = one("package_field_unknown", "agents[0].temprature");
      expect(field).toMatchObject({ severity: "warning", suggestion: "temperature" });
      expect(field.message).toBe('"temprature" is not a field of the package schema here; the import ignores it. Did you mean "temperature"?');
      expect(lineOf(field)).toMatch(/temprature: 0\.9/);

      // A required field under another name: one finding, the schema's, saying what was meant.
      const renamed = one("package_schema_invalid", "agents[0].handoffs[1]");
      expect(renamed).toMatchObject({ severity: "error", suggestion: "to_agent_slug" });
      expect(renamed.message).toBe('missing required field "to_agent_slug" ("target_agent_slug" is set, which the package schema does not have; did you mean "to_agent_slug"?)');
      expect(findings.filter((f) => f.path.startsWith("agents[0].handoffs[1]"))).toHaveLength(1);

      const model = one("package_model_unknown", "agents[0].llm_model");
      expect(model).toMatchObject({ severity: "warning", file: "package/agents.yaml" });
      expect(model.message).toMatch(/^The agent "helper" uses the model "gpt-9-ultra", which is not in the tenant's model list \(.+\)\.$/);
      expect(lineOf(model)).toMatch(/llm_model: gpt-9-ultra/);

      // Nothing else: one finding per mistake.
      expect(findings).toHaveLength(9);
      for (const code of ["package_duplicate_key", "package_reference_unknown", "package_field_unknown", "package_model_unknown"]) {
        expect((await cli(sb, ["explain", code, "--json"], { cwd: dir })).json(), code).toMatchObject({ code, kind: "kit" });
      }
    } finally {
      server.state.models = [];
    }
  });

  it("keeps the model list validate checks against fresh from models list, and checks nothing without one", async () => {
    const dir = await initSolution();
    expect((await cli(sb, ["pull"], { cwd: dir })).code).toBe(0);
    const agentsFile = path.join(dir, "package", "agents.yaml");
    const agents = parse(read(agentsFile)) as Array<Record<string, unknown>>;
    agents[0]!.llm_model = "llama-70b";
    writeFileSync(agentsFile, stringify(agents));
    // An empty Model Registry: the instance's defaults serve the agents, so nothing is checked.
    expect((await cli(sb, ["validate", "--offline", "--json"], { cwd: dir })).json()).toMatchObject({ warning_count: 0 });
    server.state.models.push(modelRow(tenant, { model_id: "llama-3-70b", base_url: "http://vllm:8000/v1" }));
    try {
      expect((await cli(sb, ["models", "list"], { cwd: dir })).code).toBe(0);
      const warned = await cli(sb, ["validate", "--offline", "--json"], { cwd: dir });
      expect(warned.json<{ warnings: Array<{ code: string; message: string }> }>().warnings).toEqual([
        { code: "package_model_unknown", message: expect.stringMatching(/"llama-70b", which is not in the tenant's model list \(.+\)\. Did you mean "llama-3-70b"\?$/) },
      ]);
      // Without the inventory, references to the tenant are not checked; those inside the package still are.
      rmSync(path.join(dir, ".cavelon", "inventory.json"));
      expect((await cli(sb, ["validate", "--offline", "--json"], { cwd: dir })).json()).toMatchObject({ valid: true, warning_count: 0 });
    } finally {
      server.state.models = [];
    }
  });

  it("warns when an agent is given a knowledge base but no search tool reaches it", async () => {
    const dir = await initSolution();
    await cli(sb, ["pull"], { cwd: dir });
    const skillsFile = path.join(dir, "package", "skills.yaml");
    const agentsFile = path.join(dir, "package", "agents.yaml");
    const skills = parse(read(skillsFile)) as Array<Record<string, unknown>>;
    expect(skills[0]).toMatchObject({ slug: "faq", tool_assignments: [{ tool_slug: "search_documents" }] });
    expect((await cli(sb, ["validate", "--offline", "--json"], { cwd: dir })).json()).toMatchObject({ warning_count: 0, warnings: [] });

    // The shape a copied skill often has: knowledge bases, and no tool to search them.
    delete skills[0]!.tool_assignments;
    writeFileSync(skillsFile, stringify(skills));
    const warned = await cli(sb, ["validate", "--offline", "--json"], { cwd: dir });
    expect(warned.code, warned.stdout).toBe(0);
    const result = warned.json<{ valid: boolean; findings: Array<{ code: string; severity: string; file: string; line: number; message: string; hint: string; docs: string }> }>();
    expect(result.valid).toBe(true);
    expect(result.findings).toEqual([
      expect.objectContaining({ code: "knowledge_base_without_search_tool", severity: "warning", file: "package/skills.yaml" }),
    ]);
    expect(read(skillsFile).split("\n")[result.findings[0]!.line - 1]).toMatch(/knowledge_base_name: Handbook/);
    expect(result.findings[0]!.message).toBe(
      'The agent "helper" is given the knowledge base "Handbook" through the skill "faq", but no tool that searches or lists it reaches the agent, so it cannot read it: add search_documents (or list_documents) to the skill\'s tool_assignments.',
    );
    expect(result.findings[0]!.hint).toMatch(/tool_slug: search_documents/);
    expect(result.findings[0]!.docs).toMatch(/builtin-tools#binding-knowledge-bases-to-search_documents$/);

    // The agent's own assignment of the tool reaches it as well.
    const agents = parse(read(agentsFile)) as Array<Record<string, unknown>>;
    agents[0]!.tool_assignments = [{ tool_slug: "search_documents" }];
    writeFileSync(agentsFile, stringify(agents));
    expect((await cli(sb, ["validate", "--offline", "--json"], { cwd: dir })).json()).toMatchObject({ warning_count: 0, warnings: [], findings: [] });

    // list_documents lists the knowledge base's documents, and read_document reads them: that reaches it too.
    agents[0]!.tool_assignments = [{ tool_slug: "list_documents", config_overrides: { knowledge_base_names: ["Handbook"] } }, { tool_slug: "read_document" }];
    agents[0]!.skill_assignments = [];
    writeFileSync(agentsFile, stringify(agents));
    expect((await cli(sb, ["validate", "--offline", "--json"], { cwd: dir })).json()).toMatchObject({ warning_count: 0, warnings: [] });
    // So does a tenant's tool whose builtin_key is list_documents, under a slug of its own.
    agents[0]!.tool_assignments = [{ tool_slug: "list_events", config_overrides: { knowledge_base_names: ["Handbook"] } }];
    writeFileSync(agentsFile, stringify(agents));
    const toolsFile = path.join(dir, "package", "tools.yaml");
    const pulledTools = read(toolsFile);
    const tools = parse(pulledTools) as Array<Record<string, unknown>>;
    writeFileSync(toolsFile, stringify([...tools, { slug: "list_events", name: "List events", tool_type: "builtin", builtin_key: "list_documents" }]));
    const listed = await cli(sb, ["validate", "--offline", "--json"], { cwd: dir });
    expect(listed.json<{ findings: Array<{ code: string }> }>().findings.filter((f) => f.code === "knowledge_base_without_search_tool")).toEqual([]);
    writeFileSync(toolsFile, pulledTools);
    agents[0]!.skill_assignments = [{ skill_slug: "faq" }];

    // An agent's tool assignment that names knowledge bases on another tool is no search either.
    agents[0]!.tool_assignments = [{ tool_slug: "crm", config_overrides: { knowledge_base_names: ["Handbook"] } }];
    agents[0]!.skill_assignments = [];
    writeFileSync(agentsFile, stringify(agents));
    const own = await cli(sb, ["validate", "--offline"], { cwd: dir });
    expect(own.stdout).toMatch(
      /warning knowledge_base_without_search_tool {2}package\/agents\.yaml:\d+ agents\[0\]\.tool_assignments\[0\]\.config_overrides\.knowledge_base_names: The agent "helper" is given the knowledge base "Handbook", but no tool that searches or lists it reaches the agent/,
    );

    // A skill this package does not carry, which the tenant holds, may bring the tool: no warning.
    agents[0]!.skill_assignments = [{ skill_slug: "tenant-wide-search" }];
    writeFileSync(agentsFile, stringify(agents));
    const inventoryFile = path.join(dir, ".cavelon", "inventory.json");
    const inventory = JSON.parse(read(inventoryFile)) as { names: { skills: string[] } };
    inventory.names.skills.push("tenant-wide-search");
    writeFileSync(inventoryFile, JSON.stringify(inventory));
    expect((await cli(sb, ["validate", "--offline", "--json"], { cwd: dir })).json()).toMatchObject({ warning_count: 0, warnings: [] });

    const explained = await cli(sb, ["explain", "knowledge_base_without_search_tool", "--json"], { cwd: dir });
    expect(explained.json()).toMatchObject({ code: "knowledge_base_without_search_tool", kind: "kit" });
  });

  it("says what to do when no schema is cached and it may not ask", async () => {
    const dir = await initSolution();
    await cli(sb, ["pull"], { cwd: dir });
    const fresh = sandbox();
    try {
      const result = await cli(fresh, ["validate", "--offline", "--json"], { cwd: dir });
      expect(result.code).toBe(1);
      expect(result.json<{ error: { hint: string } }>().error.hint).toMatch(/without --offline/);
    } finally {
      fresh.cleanup();
    }
  });
});

describe("a test step's assertions, on an instance whose schema publishes them", () => {
  /** A step's criteria as an instance before the criterion shapes publishes them: a list of anything. */
  const withoutCriteria = (schema: { properties: Record<string, unknown> }) => {
    const all = schema as unknown as { $defs: Record<string, { properties: Record<string, unknown> }> };
    for (const name of Object.keys(all.$defs)) if (name === "CriterionSpec" || name.endsWith("Criterion")) delete all.$defs[name];
    all.$defs.PackageTestCaseStep!.properties.evaluation_criteria = { anyOf: [{ type: "array", items: {} }, { type: "null" }], default: null, title: "Evaluation Criteria" };
  };
  let own: Sandbox;

  async function solution(steps: string): Promise<string> {
    await login(own, server.url, token);
    const dir = path.join(own.home, "solution");
    mkdirSync(dir);
    expect((await cli(own, ["init", "--instance", server.url, "--tenant", tenant, "--harness", "support"], { cwd: dir })).code).toBe(0);
    expect((await cli(own, ["pull"], { cwd: dir })).code).toBe(0);
    writeFileSync(
      path.join(dir, "tests", "routing.yaml"),
      `name: Routing\nharness_slug: support\ntest_cases:\n  - name: Family ticket price\n    steps:\n      - user_message: What does a family ticket cost?\n        evaluation_criteria:\n${steps}`,
    );
    return dir;
  }

  beforeEach(() => {
    own = sandbox();
  });
  afterEach(() => {
    server.state.packageSchemaEdit = null;
    own.cleanup();
  });

  const routing =
    "          - States the price of the family ticket.\n" +
    "          - {type: handoff_to, value: helper}\n" +
    "          - {type: answered_by, value: helper}\n" +
    "          - {type: tool_called, value: search_documents}\n" +
    "          - {type: tool_not_called, value: crm}\n";

  it("validate accepts handoff_to, answered_by, tool_called and tool_not_called, and fmt leaves them as written", async () => {
    const dir = await solution(routing);
    const valid = await cli(own, ["validate", "--json"], { cwd: dir });
    expect(valid.code, valid.stdout).toBe(0);
    expect(valid.json<{ findings: unknown[] }>().findings).toEqual([]);
    expect((await cli(own, ["fmt"], { cwd: dir })).code).toBe(0);
    const step = (parse(readFileSync(path.join(dir, "tests", "routing.yaml"), "utf8")) as { test_cases: Array<{ steps: Array<{ evaluation_criteria: unknown[] }> }> }).test_cases[0]!.steps[0]!;
    expect(step.evaluation_criteria).toEqual([
      "States the price of the family ticket.",
      { type: "handoff_to", value: "helper" },
      { type: "answered_by", value: "helper" },
      { type: "tool_called", value: "search_documents" },
      { type: "tool_not_called", value: "crm" },
    ]);
    expect((await cli(own, ["validate", "--json"], { cwd: dir })).code).toBe(0);
  });

  it("on an instance whose schema does not describe a step's criteria, validate warns once per suite file that it cannot check them", async () => {
    server.state.packageSchemaEdit = withoutCriteria;
    const dir = await solution(routing);
    const result = await cli(own, ["validate", "--json"], { cwd: dir });
    expect(result.code, result.stdout).toBe(0);
    const findings = result.json<{ findings: Array<{ code: string; severity: string; file: string; line: number; message: string }> }>().findings;
    expect(findings).toEqual([
      expect.objectContaining({
        code: "test_assertion_unchecked",
        severity: "warning",
        file: "tests/routing.yaml",
        line: 9,
        message: expect.stringContaining("(handoff_to, answered_by, tool_called, tool_not_called) are not checked"),
      }),
    ]);
    expect((await cli(own, ["explain", "test_assertion_unchecked"], { cwd: dir })).stdout).toMatch(/grades it as a judge criterion/);
  });

  it("validate names a routing assertion without its agent, and one with a field it does not take", async () => {
    const dir = await solution("          - {type: handoff_to}\n          - {type: answered_by, value: helper, agent: front-desk}\n");
    const result = await cli(own, ["validate", "--json"], { cwd: dir });
    expect(result.code).toBe(3);
    const findings = result.json<{ findings: Array<{ code: string; file: string; path: string; message: string }> }>().findings;
    // Only what the closest shape (the routing assertion) says, not every other kind of criterion's complaints.
    const at = "test_suites[1].test_cases[0].steps[0].evaluation_criteria";
    expect(findings.map((f) => [f.file, f.path, f.message])).toEqual([
      ["tests/routing.yaml", `${at}[0]`, 'missing required field "value"'],
      ["tests/routing.yaml", `${at}[1]`, 'field "agent" is not allowed here'],
    ]);
  });
});

describe("validate on an instance whose schema changes under one version", () => {
  /** The section a development build gains while it keeps reporting v0.0.0-dev. */
  const gainNotes = (schema: { properties: Record<string, unknown> }) => {
    schema.properties.deployment_notes = { type: "object", additionalProperties: true };
  };
  const later = (minutes: number) => () => new Date(Date.now() + minutes * 60_000);
  let own: Sandbox;

  type Validated = { warning_count: number; warnings: Array<{ code: string | null; message: string }>; findings: Array<{ code: string; message: string }>; schema: { source: string; instance_version: string; fetched_at: string; etag: string | null; sha256: string; stale: boolean } };

  async function solutionIn(box: Sandbox): Promise<string> {
    await login(box, server.url, token);
    const dir = path.join(box.home, "solution");
    mkdirSync(dir);
    const init = await cli(box, ["init", "--instance", server.url, "--tenant", tenant, "--harness", "support"], { cwd: dir });
    expect(init.code, init.stderr + init.stdout).toBe(0);
    expect((await cli(box, ["pull"], { cwd: dir })).code).toBe(0);
    writeFileSync(path.join(dir, "package", "deployment_notes.yaml"), "owner: ops\n");
    return dir;
  }

  beforeEach(() => {
    own = sandbox();
  });
  afterEach(() => {
    server.state.packageSchemaEdit = null;
    server.state.packageSchemaEtag = false;
    server.state.capsPatch = {};
    own.cleanup();
  });

  it("reads a development build's schema again once its copy is a minute old, and says which copy it used", async () => {
    const dir = await solutionIn(own);
    const before = await cli(own, ["validate", "--json"], { cwd: dir });
    const first = before.json<Validated>();
    expect(first.findings).toEqual([expect.objectContaining({ code: "package_section_unknown" })]);
    expect(first.schema).toMatchObject({ source: "cache", instance_version: "v0.0.0-dev", etag: null, stale: false });

    server.state.packageSchemaEdit = gainNotes;
    // Within the time-to-live the cached copy is trusted, and the instance is not asked.
    server.state.requests.length = 0;
    expect((await cli(own, ["validate", "--json"], { cwd: dir })).json<Validated>()).toMatchObject({ warning_count: 1, schema: { source: "cache", sha256: first.schema.sha256 } });
    expect(server.state.requests.filter((r) => r.path === "/api/v1/meta/package-schema")).toEqual([]);

    // Offline, an old copy is used and said to be old.
    const offline = (await cli(own, ["validate", "--offline", "--json"], { cwd: dir, now: later(2) })).json<Validated>();
    expect(offline).toMatchObject({ warning_count: 1, schema: { source: "cache", stale: true } });

    const after = await cli(own, ["validate", "--json", "--verbose"], { cwd: dir, now: later(2) });
    expect(after.code, after.stdout).toBe(0);
    const second = after.json<Validated>();
    expect(second).toMatchObject({ warning_count: 0, warnings: [], findings: [], schema: { source: "instance", instance_version: "v0.0.0-dev", stale: false } });
    expect(second.schema.sha256).not.toBe(first.schema.sha256);

    // From here on the new copy is the cached one, offline as well.
    const text = await cli(own, ["validate", "--offline", "--verbose"], { cwd: dir, now: later(2) });
    expect(text.stdout).toMatch(new RegExp(`^Schema: package format v3, cached at \\S+, instance v0\\.0\\.0-dev \\(sha256 ${second.schema.sha256}\\); a development build: read again after 60 s\\.$`, "m"));
    expect(text.stdout).not.toMatch(/package_section_unknown/);
  });

  it("checks a cached schema with the ETag the instance sent, and takes the new one when it changed", async () => {
    server.state.packageSchemaEtag = true;
    const dir = await solutionIn(own);
    const first = (await cli(own, ["validate", "--json"], { cwd: dir })).json<Validated>();
    expect(first.schema.etag).toMatch(/^"[0-9a-f]+"$/);

    // Unchanged: the instance answers 304 and the copy is kept, now checked.
    server.state.requests.length = 0;
    const same = (await cli(own, ["validate", "--json"], { cwd: dir, now: later(2) })).json<Validated>();
    expect(same).toMatchObject({ warning_count: 1, schema: { source: "instance", etag: first.schema.etag, sha256: first.schema.sha256 } });
    const asked = server.state.requests.filter((r) => r.path === "/api/v1/meta/package-schema");
    expect(asked.map((r) => r.headers["if-none-match"])).toEqual([first.schema.etag]);

    server.state.packageSchemaEdit = gainNotes;
    const changed = (await cli(own, ["validate", "--json"], { cwd: dir, now: later(4) })).json<Validated>();
    expect(changed).toMatchObject({ warning_count: 0, warnings: [], schema: { source: "instance" } });
    expect(changed.schema.etag).not.toBe(first.schema.etag);
  });

  it("keeps a release's cached schema: its version changes with its schema", async () => {
    server.state.capsPatch = { instance: { version: "v1.4.0", phase: "ga" } };
    const dir = await solutionIn(own);
    server.state.packageSchemaEdit = gainNotes;
    const result = (await cli(own, ["validate", "--json"], { cwd: dir, now: later(30) })).json<Validated>();
    expect(result).toMatchObject({ warning_count: 1, schema: { source: "cache", instance_version: "v1.4.0", stale: false } });
  });

  it("uses a development build's old copy, with a warning, when the instance cannot be read", async () => {
    const dir = await solutionIn(own);
    server.state.packageSchemaEdit = () => {
      throw new Error("schema store unavailable");
    };
    const result = await cli(own, ["validate", "--json"], { cwd: dir, now: later(2) });
    expect(result.code, result.stdout).toBe(0);
    const data = result.json<Validated>();
    expect(data).toMatchObject({ findings: [expect.objectContaining({ code: "package_section_unknown" })], schema: { source: "cache", stale: true } });
    expect(result.stderr).toMatch(/Could not read the package schema again from the instance \(.+\); using the copy cached at \S+ for development build v0\.0\.0-dev\./);
  });

  it("reports warnings in one shape, with and without a warning about the run", async () => {
    const dir = await solutionIn(own);
    const without = (await cli(own, ["validate", "--json"], { cwd: dir })).json<Validated & Record<string, unknown>>();
    expect(without).toMatchObject({ error_count: 0, errors: 0, warning_count: 1 });
    expect(without.warnings).toEqual([{ code: "package_section_unknown", message: without.findings[0]!.message }]);

    // The instance cannot be read, so the old copy is used with a warning about the run: listed after the package's, code null.
    server.state.packageSchemaEdit = () => {
      throw new Error("schema store unavailable");
    };
    const run = await cli(own, ["validate", "--json"], { cwd: dir, now: later(2) });
    expect(run.code, run.stdout).toBe(0);
    const withRun = run.json<Validated & Record<string, unknown>>();
    expect(withRun).toMatchObject({ error_count: 0, errors: 0, warning_count: 2 });
    expect(withRun.warnings).toEqual([
      { code: "package_section_unknown", message: without.findings[0]!.message },
      { code: null, message: expect.stringMatching(/^Could not read the package schema again from the instance/) },
    ]);
    expect(Object.keys(withRun).sort()).toEqual(Object.keys(without).sort());

    // --limit bounds the package's warnings; the count still says how many there are.
    const limited = (await cli(own, ["validate", "--json", "--limit", "1"], { cwd: dir, now: later(2) })).json<Validated>();
    expect(limited.warning_count).toBe(2);
    expect(limited.warnings.map((w) => w.code)).toEqual(["package_section_unknown", null]);
  });
});

describe("apply", () => {
  async function pulled(): Promise<string> {
    const dir = await initSolution();
    expect((await cli(sb, ["pull"], { cwd: dir })).code).toBe(0);
    return dir;
  }

  it("previews, stores the preview, and imports exactly it on --confirm", async () => {
    const dir = await pulled();
    server.state.previewExtras = {
      target_needs: { secrets: [{ name: "crm_token", references: ["tools[0].webhook_config.headers.Authorization"] }], oauth_grants: [], runtime_bindings: [], trigger_identities: [] },
    };
    const preview = await cli(sb, ["apply", "--json"], { cwd: dir });
    expect(preview.code, preview.stdout).toBe(0);
    const data = preview.json<{ preview_id: string; ready: boolean; harness: { slug: string } }>();
    expect(data.preview_id).toMatch(/^pv_/);
    expect(data.harness.slug).toBe("support");
    const stored = path.join(dir, ".cavelon", "previews", `${data.preview_id}.json`);
    expect(existsSync(stored)).toBe(true);
    expect(server.state.requests.some((r) => r.path === "/api/v1/agent-graph/import")).toBe(false);

    const text = await cli(sb, ["apply"], { cwd: dir });
    expect(text.stdout).toMatch(/needs secrets:\s+- crm_token: cavelon secrets set crm_token/);
    expect(text.stdout).toMatch(new RegExp(`Import exactly this: cavelon apply --confirm ${data.preview_id}`));

    // The files change after the preview: the confirm is stale, exits 4 and imports nothing, and the preview stays.
    const agentsFile = path.join(dir, "package", "agents.yaml");
    writeFileSync(agentsFile, read(agentsFile).replace("temperature: 0.2", "temperature: 0.5"));
    server.state.requests.length = 0;
    const stale = await cli(sb, ["apply", "--confirm", data.preview_id, "--json"], { cwd: dir });
    expect(stale.code, stale.stdout).toBe(4);
    const error = stale.json<{ error: { code: string; message: string; hint: string; details: { files: string[] } } }>().error;
    expect(error).toMatchObject({ code: "preview_files_changed", details: { files: ["package/agents.yaml"] } });
    expect(error.message).toMatch(/changed since preview .* \(package\/agents\.yaml\); nothing was imported/);
    expect(error.hint).toMatch(/Run `cavelon apply --harness support` for a preview of the files as they are now.*add --allow-stale to the confirm/);
    expect(server.state.requests.some((r) => r.path === "/api/v1/agent-graph/import")).toBe(false);
    expect(existsSync(stored)).toBe(true);

    // --allow-stale imports what the preview showed, and says so.
    const confirmed = await cli(sb, ["apply", "--confirm", data.preview_id, "--allow-stale", "--json"], { cwd: dir });
    expect(confirmed.code, confirmed.stdout).toBe(0);
    expect(confirmed.json<{ applied: boolean; warnings: string[] }>()).toMatchObject({ applied: true });
    expect(confirmed.json<{ warnings: string[] }>().warnings.join()).toMatch(/files changed since this preview \(package\/agents\.yaml\); importing what the preview showed \(--allow-stale\)/);
    const sent = server.state.requests.find((r) => r.path === "/api/v1/agent-graph/import")!.body as Record<string, any>;
    expect(sent.preview_id).toBe(data.preview_id);
    expect(sent.package.agents[0].temperature).toBe(0.2);
    expect(existsSync(stored)).toBe(false);
    // The file holds what the instance does not, so pull does not take it for the instance's.
    const refused = await cli(sb, ["pull", "--json"], { cwd: dir });
    expect(refused.code).toBe(4);
    expect(refused.json<{ error: { details: { files: string[] } } }>().error.details.files).toEqual(["package/agents.yaml"]);
    expect(read(agentsFile)).toContain("temperature: 0.5");
  });

  it("after a confirm, a file whose bytes changed since the preview but whose content the instance holds is the base for pull", async () => {
    const dir = await pulled();
    const agentsFile = path.join(dir, "package", "agents.yaml");
    writeFileSync(agentsFile, read(agentsFile).replace("temperature: 0.2", "temperature: 0.5"));
    const preview = (await cli(sb, ["apply", "--json"], { cwd: dir })).json<{ preview_id: string }>();
    // Only the formatting changes since: the package is the previewed one, so the confirm is not stale.
    writeFileSync(agentsFile, `# Tuned for the FAQ.\n${read(agentsFile)}`);
    server.state.requests.length = 0;
    const confirmed = await cli(sb, ["apply", "--confirm", preview.preview_id, "--json"], { cwd: dir });
    expect(confirmed.code, confirmed.stdout).toBe(0);
    expect(confirmed.json<{ warnings?: string[] }>().warnings ?? []).toEqual([]);
    expect(server.state.requests.some((r) => r.method === "GET" && r.path === "/api/v1/agent-graph/export")).toBe(true);
    const pulledAgain = await cli(sb, ["pull"], { cwd: dir });
    expect(pulledAgain.code, pulledAgain.stderr + pulledAgain.stdout).toBe(0);
    expect(read(agentsFile)).toMatch(/^# Tuned for the FAQ\.\n[\s\S]*temperature: 0\.5/);
  });

  it("after a confirm, a changed file stays a local change for pull when the instance's export cannot be read", async () => {
    const dir = await pulled();
    const agentsFile = path.join(dir, "package", "agents.yaml");
    const preview = (await cli(sb, ["apply", "--json"], { cwd: dir })).json<{ preview_id: string }>();
    writeFileSync(agentsFile, `# Tuned for the FAQ.\n${read(agentsFile)}`);
    server.state.failures = [{ method: "GET", path: /\/agent-graph\/export$/, status: 503 }];
    try {
      const confirmed = await cli(sb, ["apply", "--confirm", preview.preview_id, "--json"], { cwd: dir });
      expect(confirmed.code, confirmed.stdout).toBe(0);
      expect(confirmed.json<{ applied: boolean; warnings: string[] }>()).toMatchObject({ applied: true });
      expect(confirmed.json<{ warnings: string[] }>().warnings.join()).toMatch(/Could not read what the instance holds after the import .*; pull treats package\/agents\.yaml as local changes/);
    } finally {
      server.state.failures = [];
    }
    // No base for the file: pull refuses to overwrite it, and keeps it where the instance holds the same.
    const base = JSON.parse(read(path.join(dir, ".cavelon", "pulled-files.json"))) as { digests: Record<string, string> };
    expect(Object.keys(base.digests)).not.toContain("package/agents.yaml");
    expect(Object.keys(base.digests)).toContain("package/manifest.yaml");
    const pulledAgain = await cli(sb, ["pull"], { cwd: dir });
    expect(pulledAgain.code, pulledAgain.stderr + pulledAgain.stdout).toBe(0);
    expect(read(agentsFile)).toMatch(/^# Tuned for the FAQ\./);
  });

  it("a preview older than a day expires: its confirm exits 4, status says so, and a new preview removes it", async () => {
    const dir = await pulled();
    const preview = (await cli(sb, ["apply", "--json"], { cwd: dir })).json<{ preview_id: string }>();
    const stored = path.join(dir, ".cavelon", "previews", `${preview.preview_id}.json`);
    const age = (hours: number) => {
      const record = JSON.parse(read(stored));
      record.created_at = new Date(Date.now() - hours * 3_600_000).toISOString();
      writeFileSync(stored, JSON.stringify(record));
      return record.created_at as string;
    };

    const fresh = age(23);
    let status = (await cli(sb, ["status", "--offline", "--json"], { cwd: dir })).json<{ solution: { open_previews: Array<Record<string, unknown>> } }>();
    expect(status.solution.open_previews).toEqual([
      expect.objectContaining({ preview_id: preview.preview_id, created_at: fresh, expires_at: new Date(Date.parse(fresh) + 86_400_000).toISOString(), expired: false }),
    ]);

    age(25);
    status = (await cli(sb, ["status", "--offline", "--json"], { cwd: dir })).json();
    expect(status.solution.open_previews).toEqual([expect.objectContaining({ preview_id: preview.preview_id, expired: true })]);
    expect((await cli(sb, ["status", "--offline"], { cwd: dir })).stdout).toMatch(/expired \(`cavelon apply --discard all` removes it\)/);
    server.state.requests.length = 0;
    const expired = await cli(sb, ["apply", "--confirm", preview.preview_id, "--json"], { cwd: dir });
    expect(expired.code).toBe(4);
    expect(expired.json<{ error: { code: string; hint: string } }>().error).toMatchObject({ code: "preview_expired", hint: expect.stringMatching(/cavelon apply --harness support` again/) });
    expect(server.state.requests.some((r) => r.path === "/api/v1/agent-graph/import")).toBe(false);
    expect(existsSync(stored)).toBe(false);

    // A new preview in the folder removes the expired ones.
    const replaced = (await cli(sb, ["apply", "--mode", "replace", "--json"], { cwd: dir })).json<{ preview_id: string }>();
    const again = (await cli(sb, ["apply", "--json"], { cwd: dir })).json<{ preview_id: string }>();
    const replacedFile = path.join(dir, ".cavelon", "previews", `${replaced.preview_id}.json`);
    const record = JSON.parse(read(replacedFile));
    record.created_at = new Date(Date.now() - 48 * 3_600_000).toISOString();
    writeFileSync(replacedFile, JSON.stringify(record));
    expect((await cli(sb, ["apply", "--json"], { cwd: dir })).code).toBe(0);
    expect(readdirSync(path.join(dir, ".cavelon", "previews"))).toEqual([`${again.preview_id}.json`]);
  });

  it("--discard forgets one stored preview or all of them, and changes nothing on the instance", async () => {
    const dir = await pulled();
    const first = (await cli(sb, ["apply", "--json"], { cwd: dir })).json<{ preview_id: string }>();
    const second = (await cli(sb, ["apply", "--mode", "replace", "--json"], { cwd: dir })).json<{ preview_id: string }>();
    expect(first.preview_id).not.toBe(second.preview_id);
    const previews = path.join(dir, ".cavelon", "previews");
    server.state.requests.length = 0;

    const one = await cli(sb, ["apply", "--discard", first.preview_id, "--json"], { cwd: dir });
    expect(one.code).toBe(0);
    expect(one.json()).toEqual({ discarded: [first.preview_id], count: 1 });
    expect(readdirSync(previews)).toEqual([`${second.preview_id}.json`]);
    // A discarded preview's confirm says so, as a stale preview's does (exit 4).
    const discarded = await cli(sb, ["apply", "--confirm", first.preview_id, "--json"], { cwd: dir });
    expect(discarded.code).toBe(4);
    expect(discarded.json<{ error: { code: string } }>().error.code).toBe("preview_discarded");
    expect((await cli(sb, ["apply", "--discard", first.preview_id], { cwd: dir })).code).toBe(2);

    const all = await cli(sb, ["apply", "--discard", "all"], { cwd: dir });
    expect(all.code).toBe(0);
    expect(all.stdout).toMatch(new RegExp(`^Discarded preview: ${second.preview_id}\\. Nothing changed on the instance\\.`));
    expect(readdirSync(previews)).toEqual([]);
    expect((await cli(sb, ["apply", "--discard", "all", "--json"], { cwd: dir })).json()).toEqual({ discarded: [], count: 0 });
    expect(server.state.requests.filter((r) => r.path.startsWith("/api/v1/agent-graph"))).toEqual([]);

    expect((await cli(sb, ["apply", "--discard", "all", "--confirm", first.preview_id], { cwd: dir })).code).toBe(2);
    expect((await cli(sb, ["apply", "--allow-stale"], { cwd: dir })).code).toBe(2);
  });

  it("turns a stale preview into exit 4 with the way forward", async () => {
    const dir = await pulled();
    const preview = (await cli(sb, ["apply", "--json"], { cwd: dir })).json<{ preview_id: string }>();
    server.editConfig(tenant, (pkg) => {
      (pkg.knowledge_bases as Array<Record<string, unknown>>)[0]!.description = "Edited in the Admin";
    });
    const result = await cli(sb, ["apply", "--confirm", preview.preview_id, "--json"], { cwd: dir });
    expect(result.code).toBe(4);
    const error = result.json<{ error: { code: string; hint: string; exit_code: number } }>().error;
    expect(error).toMatchObject({ code: "import_preview_stale", exit_code: 4 });
    expect(error.hint).toMatch(/cavelon apply --harness support` again/);
    expect(existsSync(path.join(dir, ".cavelon", "previews", `${preview.preview_id}.json`))).toBe(false);
  });

  it("says a confirmed preview was imported, and one made before it superseded (exit 4), instead of not knowing them", async () => {
    const dir = await pulled();
    const first = (await cli(sb, ["apply", "--json"], { cwd: dir })).json<{ preview_id: string }>();
    const second = (await cli(sb, ["apply", "--mode", "replace", "--json"], { cwd: dir })).json<{ preview_id: string }>();
    expect((await cli(sb, ["apply", "--confirm", second.preview_id], { cwd: dir })).code).toBe(0);
    const before = server.state.requests.length;

    const superseded = await cli(sb, ["apply", "--confirm", first.preview_id, "--json"], { cwd: dir });
    expect(superseded.code).toBe(4);
    const error = superseded.json<{ error: { code: string; message: string; hint: string; details: Record<string, unknown> } }>().error;
    expect(error).toMatchObject({ code: "preview_superseded", details: { preview_id: first.preview_id, reason: "superseded", superseded_by: second.preview_id } });
    expect(error.message).toMatch(new RegExp(`^Preview ${first.preview_id} was superseded: preview ${second.preview_id} was imported after it`));
    expect(error.hint).toMatch(/^Run `cavelon apply` for a new preview/);

    const applied = await cli(sb, ["apply", "--confirm", second.preview_id, "--json"], { cwd: dir });
    expect(applied.code).toBe(4);
    expect(applied.json<{ error: { code: string } }>().error.code).toBe("preview_applied");
    // An id this folder never stored is still a usage error.
    expect((await cli(sb, ["apply", "--confirm", "pv1_unknown", "--json"], { cwd: dir })).code).toBe(2);
    expect(server.state.requests.slice(before).filter((r) => r.method !== "GET")).toEqual([]);
    expect((await cli(sb, ["explain", "preview_superseded", "--json"], { cwd: dir })).json()).toMatchObject({ code: "preview_superseded", kind: "cli" });
  });

  it("says there is nothing to import when the preview changes nothing, and stores no preview to confirm", async () => {
    const dir = await pulled();
    server.state.previewExtras = { summary: { creates: {}, updates: {}, deletes: {}, references: { agents: 1 }, warnings: 0, blockers: 0 } };
    try {
      const result = await cli(sb, ["apply"], { cwd: dir });
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toMatch(/^changes: +none$/m);
      expect(result.stdout).toMatch(/Nothing to import: the instance already holds what the package files say\. No preview was stored\.$/m);
      expect(result.stdout).not.toMatch(/--confirm|preview id/);
      const json = (await cli(sb, ["apply", "--json"], { cwd: dir })).json<Record<string, unknown>>();
      expect(json).toMatchObject({ previewed: true, nothing_to_import: true });
      expect(json.preview_id).toBeUndefined();
      expect(existsSync(path.join(dir, ".cavelon", "previews")) ? readdirSync(path.join(dir, ".cavelon", "previews")) : []).toEqual([]);
    } finally {
      server.state.previewExtras = {};
    }
  });

  it("never creates the solution an env file names: it names the command that does, and binds runtime requirements once it exists", async () => {
    const dir = await pulled();
    const binding = "8f2b7c1e-1111-4222-8333-444455556666";
    writeFileSync(path.join(dir, "env", "test.yaml"), `harness: support-test\nruntime_bindings:\n  workspace: ${binding}\n`);
    server.state.requests.length = 0;
    const result = await cli(sb, ["apply", "--env", "test", "--json"], { cwd: dir });
    expect(result.code, result.stdout).toBe(1);
    const error = result.json<{ error: { code: string; message: string; hint: string; details: { create: string } } }>().error;
    expect(error.code).toBe("solution_not_found");
    expect(error.message).toBe("Solution support-test, which env/test.yaml names, is not on the instance yet; apply previews into an existing solution and creates none.");
    // The package's harness of another slug does not name it: a copied package never names someone else's solution.
    expect(error.details.create).toBe("cavelon harness new support-test");
    expect(error.hint).toBe("Create it as a draft: cavelon harness new support-test, then run `cavelon apply --env test` again.");
    expect(server.state.harnesses.find((h) => h.slug === "support-test")).toBeUndefined();
    expect(server.state.requests.filter((r) => r.method !== "GET")).toEqual([]);
    // With --tenant, the command that creates the draft creates it in that tenant.
    const other = await cli(sb, ["apply", "--env", "test", "--tenant", tenant, "--json"], { cwd: dir });
    expect(other.code).toBe(1);
    expect(other.json<{ error: { details: { create: string } } }>().error.details.create).toBe(`cavelon harness new support-test --tenant ${tenant}`);

    expect((await cli(sb, ["harness", "new", "support-test", "--name", "Support test"], { cwd: dir })).code).toBe(0);
    const previewed = await cli(sb, ["apply", "--env", "test", "--json"], { cwd: dir });
    expect(previewed.code, previewed.stdout).toBe(0);
    const created = server.state.harnesses.find((h) => h.slug === "support-test")!;
    expect(previewed.json<{ harness: Record<string, unknown> }>().harness).toEqual({ id: created.id, slug: "support-test" });
    const sent = server.state.requests.filter((r) => r.path === "/api/v1/agent-graph/import/preview").pop()!.body as Record<string, any>;
    expect(sent).toMatchObject({ harness_id: created.id, runtime_bindings: { workspace: binding }, mode: "overwrite" });

    // A harness named on the command line gets the closest ones, not a create command.
    const missing = await cli(sb, ["apply", "--harness", "nope", "--json"], { cwd: dir });
    expect(missing.code).toBe(1);
    expect(missing.json<{ error: { code: string; message: string } }>().error).toMatchObject({ code: "solution_not_found", message: expect.stringMatching(/^No solution "nope"/) });
  });

  it("names the missing solution after the package's harness with that slug", async () => {
    const dir = await pulled();
    writeFileSync(
      path.join(dir, "package", "harnesses.yaml"),
      "- slug: support-parent\n  name: Support parent\n  status: draft\n- slug: support-loop\n  name: Support loop\n  status: draft\n",
    );
    writeFileSync(path.join(dir, "env", "test.yaml"), "harness: support-loop\n");
    const named = await cli(sb, ["apply", "--env", "test", "--json"], { cwd: dir });
    expect(named.code, named.stdout).toBe(1);
    expect(named.json<{ error: { hint: string } }>().error.hint).toContain(`cavelon harness new support-loop --name ${shellWord("Support loop")}, then`);
    expect(server.state.harnesses.find((h) => h.slug === "support-loop")).toBeUndefined();
  });

  it("asks for a person when the preview reaches an active solution", async () => {
    const dir = await pulled();
    server.state.previewExtras = {
      impact: { changed_tools: [], changed_knowledge_bases: ["Handbook"], active_harnesses: [{ harness_slug: "support", name: "Support", knowledge_bases: ["Handbook"], tools: [], sandboxes: [] }], sandbox_writers: [] },
    };
    const result = await cli(sb, ["apply"], { cwd: dir });
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/reaches active:\s*\n\s+- Support \(support\) through Handbook/);
    expect(result.stdout).toMatch(/show this preview to a person before confirming/);
  });

  it("stops at blockers and at local validation errors, before importing", async () => {
    const dir = await pulled();
    server.state.previewBlockers = ["Tool crm needs a connection."];
    const blocked = await cli(sb, ["apply", "--json"], { cwd: dir });
    expect(blocked.code).toBe(3);
    expect(blocked.json<{ blockers: string[] }>().blockers).toEqual(["Tool crm needs a connection."]);
    expect(readdirSync(path.join(dir, ".cavelon")).includes("previews")).toBe(false);

    server.state.previewBlockers = [];
    const agentsFile = path.join(dir, "package", "agents.yaml");
    writeFileSync(agentsFile, read(agentsFile).replace("llm_model: gpt-4.1\n", ""));
    server.state.requests.length = 0;
    const invalid = await cli(sb, ["apply", "--json"], { cwd: dir });
    expect(invalid.code).toBe(3);
    expect(server.state.requests.some((r) => r.path.startsWith("/api/v1/agent-graph/import"))).toBe(false);
  });

  it("refuses an unknown preview id and a missing env file", async () => {
    const dir = await pulled();
    expect((await cli(sb, ["apply", "--confirm", "pv_nothing"], { cwd: dir })).code).toBe(2);
    const noEnv = await cli(sb, ["apply", "--env", "staging", "--json"], { cwd: dir });
    expect(noEnv.code).toBe(2);
    expect(noEnv.json<{ error: { message: string } }>().error.message).toMatch(/env\/staging\.yaml/);
    expect((await cli(sb, ["apply", "--env", "../etc"], { cwd: dir })).code).toBe(2);
  });

  it("status lists the last pull and the open previews", async () => {
    const dir = await pulled();
    const preview = (await cli(sb, ["apply", "--json"], { cwd: dir })).json<{ preview_id: string }>();
    const status = await cli(sb, ["status", "--offline", "--json"], { cwd: dir });
    const solution = status.json<{ solution: { last_pull: { harness: { slug: string } }; open_previews: Array<{ preview_id: string }> } }>().solution;
    expect(solution.last_pull.harness.slug).toBe("support");
    expect(solution.open_previews.map((p) => p.preview_id)).toEqual([preview.preview_id]);
  });
});

describe("explain", () => {
  it("looks a rule code and an API error code up in the catalog", async () => {
    const dir = await initSolution();
    const rule = await cli(sb, ["explain", "agent_pipeline_fanout_unsupported", "--json"], { cwd: dir });
    expect(rule.code).toBe(0);
    expect(rule.json()).toMatchObject({ code: "agent_pipeline_fanout_unsupported", kind: "rule", rule: "fanout_cardinality" });
    expect(rule.json<{ docs: string }>().docs).toBe(`${server.url}/docs/reference/nodes-and-edges#graph-validation-rules`);
    const api = await cli(sb, ["explain", "package_version_unsupported"], { cwd: dir });
    expect(api.stdout).toMatch(/kind:\s+API error code \(package\)/);
    // The codes validate reports itself are explained even where the catalog lacks them.
    const kit = await cli(sb, ["explain", "package_schema_invalid", "--json"], { cwd: dir });
    expect(kit.code).toBe(0);
    expect(kit.json()).toMatchObject({ code: "package_schema_invalid", kind: expect.stringMatching(/^(kit|api)$/) });
    const unknown = await cli(sb, ["explain", "fanout_mystery", "--json"], { cwd: dir });
    expect(unknown.code).toBe(1);
    expect(unknown.json<{ error: { hint: string } }>().error.hint).toMatch(/Similar codes: \w*fanout/);
  });

  it("explains a decision an Approval node's approver rule or self-approval refused", async () => {
    const dir = await initSolution();
    const rule = await cli(sb, ["explain", "approval_approver_rule_not_met", "--json"], { cwd: dir });
    expect(rule.code).toBe(0);
    expect(rule.json()).toMatchObject({ code: "approval_approver_rule_not_met", kind: "api", area: "approval" });
    expect(rule.json<{ hint: string }>().hint).toMatch(/approvers/);
    const self = await cli(sb, ["explain", "approval_requester_cannot_decide"], { cwd: dir });
    expect(self.code).toBe(0);
    expect(self.stdout).toMatch(/kind:\s+API error code \(approval\)/);
    expect(self.stdout).toMatch(/forbid_self_approval/);
  });
});

describe("activate", () => {
  it("goes through the readiness gate only, and only with a token that may activate", async () => {
    await cli(sb, ["harness", "new", "go-live"]);
    server.state.ready = false;
    server.state.requests.length = 0;
    const notReady = await cli(sb, ["activate", "--harness", "go-live", "--json"]);
    expect(notReady.code).toBe(3);
    expect(notReady.json<{ activated: boolean }>().activated).toBe(false);
    expect(server.state.requests.some((r) => r.path.endsWith("/activate"))).toBe(false);

    server.state.ready = true;
    const done = await cli(sb, ["activate", "--harness", "go-live", "--json"]);
    expect(done.code, done.stdout).toBe(0);
    expect(done.json<{ harness: { status: string } }>().harness.status).toBe("active");
    const post = server.state.requests.find((r) => r.path.endsWith("/activate"))!;
    expect(post.body).toEqual({ force: false });
    expect((await cli(sb, ["activate", "--harness", "go-live", "--json"])).json()).toMatchObject({ already_active: true });

    const limited = sandbox();
    try {
      await login(limited, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant, mayActivate: false, tokenName: "agent" }));
      await cli(limited, ["harness", "new", "not-mine"]);
      server.state.requests.length = 0;
      const refused = await cli(limited, ["activate", "--harness", "not-mine", "--json"]);
      expect(refused.code).toBe(7);
      expect(refused.json<{ error: { code: string; message: string } }>().error).toMatchObject({ code: "token_activation_refused" });
      expect(refused.json<{ error: { message: string } }>().error.message).toMatch(/"agent" was not created with "may activate"/);
      expect(server.state.requests.some((r) => r.method === "POST")).toBe(false);
    } finally {
      limited.cleanup();
    }
  });
});

describe("activate shows the readiness it went through", () => {
  const warning = { key: "description", label: "Description and outcome", state: "warning", detail: "The outcome is undefined.", href: "/harnesses/x" };
  const checks = [
    { key: "test_run", label: "A passing test run", state: "complete", detail: "smoke passed.", href: "/harnesses/x/tests" },
    { key: "models", label: "Models configured", state: "complete", detail: "Every agent has a model.", href: "/harnesses/x/agents" },
    warning,
  ];

  it("prints each check with its result and every warning, as text and JSON", async () => {
    await cli(sb, ["harness", "new", "checked"]);
    server.state.readinessChecks = checks;
    server.state.readinessWarnings = [warning];
    const text = await cli(sb, ["activate", "--harness", "checked"]);
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout).toBe(
      [
        "Activated checked (checked); status active.",
        "Readiness checks:",
        "  complete  A passing test run: smoke passed.",
        "  complete  Models configured: Every agent has a model.",
        "  warning   Description and outcome: The outcome is undefined.",
        "Warnings:",
        "  - Description and outcome: The outcome is undefined.",
        // This tenant has no default route; a real one always has, so the line names it then.
        "Not the default route: the tenant has none where a conversation names no solution.",
        "Ask the person whether checked should answer there; that changes live traffic. Preview: cavelon harness default checked",
        "",
      ].join("\n"),
    );
    // The warning is in the output, not only on stderr.
    expect(text.stderr).toBe("");

    await cli(sb, ["harness", "new", "checked-json"]);
    const json = await cli(sb, ["activate", "--harness", "checked-json", "--json"]);
    expect(json.code).toBe(0);
    const data = json.json<{ activated: boolean; checks: unknown[]; warnings: string[] }>();
    expect(data.activated).toBe(true);
    expect(data.checks).toEqual(checks.map(({ key, label, state, detail }) => ({ key, label, state, detail })));
    expect(data.warnings).toEqual(["Description and outcome: The outcome is undefined."]);
  });

  it("lists the checks next to the blockers when not ready", async () => {
    await cli(sb, ["harness", "new", "blocked"]);
    server.state.ready = false;
    server.state.readinessChecks = [{ key: "test_run", label: "A passing test run", state: "missing", detail: "Run the regression suite.", href: "/t" }, checks[1]!];
    const text = await cli(sb, ["activate", "--harness", "blocked"]);
    expect(text.code).toBe(3);
    expect(text.stdout).toContain("Readiness checks:\n  missing   A passing test run: Run the regression suite.\n  complete  Models configured: Every agent has a model.");
  });

  it("an older instance without checks: its blockers and warnings stand in for them", async () => {
    await cli(sb, ["harness", "new", "older"]);
    server.state.readinessWithoutChecks = true;
    server.state.readinessWarnings = [warning];
    const json = await cli(sb, ["activate", "--harness", "older", "--json"]);
    expect(json.code).toBe(0);
    expect(json.json<{ checks: unknown[]; warnings: string[] }>()).toMatchObject({
      checks: [{ key: "description", state: "warning", detail: "The outcome is undefined." }],
      warnings: ["Description and outcome: The outcome is undefined."],
    });
  });
});

describe("a confirmed import its own check refuses", () => {
  const catalog = JSON.parse(read(path.join(CONTRACTS, "meta-error-catalog.json"))) as {
    api_error_codes: Array<{ code: string; message: string; hint: string }>;
  };
  const entry = (code: string) => catalog.api_error_codes.find((e) => e.code === code)!;
  const RUNTIME = "Select valid destination runtime resources and preview again.";

  async function previewed(): Promise<{ dir: string; previewId: string }> {
    const dir = await initSolution();
    expect((await cli(sb, ["pull"], { cwd: dir })).code).toBe(0);
    const preview = await cli(sb, ["apply", "--json"], { cwd: dir });
    expect(preview.code, preview.stdout).toBe(0);
    return { dir, previewId: preview.json<{ preview_id: string }>().preview_id };
  }

  type Refusal = { error: { code: string; message: string; hint: string; blockers?: string[]; exit_code: number; status: number; docs: string } };

  it("names each blocker, adds the kit's hint for a code it knows, and imports nothing", async () => {
    const code = "runtime_draft_iteration_needs_draft_parent";
    const { message, hint } = entry(code);
    const blockers = [`${RUNTIME} ${code}: ${message} ${hint}`, "Knowledge base order for solution support names knowledge base faq, which no longer exists."];
    server.state.importRequirementsChanged = { blockers };
    const { dir, previewId } = await previewed();

    const result = await cli(sb, ["apply", "--confirm", previewId, "--json"], { cwd: dir });
    expect(result.code).toBe(4);
    const error = result.json<Refusal>().error;
    expect(error).toMatchObject({ code: "package_requirements_changed", status: 409, exit_code: 4, blockers });
    expect(error.message).toBe(`The import's requirements changed since preview ${previewId}; nothing was imported; preview again.`);
    expect(error.hint).toMatch(new RegExp(`^${code}: .* Step 2 binds a draft iteration only into a draft parent`));
    expect(error.hint).toMatch(/`cavelon activate` never forces\. Run `cavelon apply --harness support` again, show the new preview, and confirm its id\.$/);
    expect(error.docs).toMatch(/\/docs\/reference\/api-endpoints#errors-and-retries$/);
    expect(server.state.configs.get(tenant)!.version).toBe(1);
    expect(existsSync(path.join(dir, ".cavelon", "previews", `${previewId}.json`))).toBe(false);
  });

  it("prints each blocker in text, and a blocker without a known code gets no kit hint", async () => {
    const blockers = ["Tool crm needs a connection.", `${RUNTIME} runtime_external_iteration_harness_unavailable`, `${RUNTIME} sandbox_binding_missing`];
    server.state.importRequirementsChanged = { blockers };
    const { dir, previewId } = await previewed();
    const text = await cli(sb, ["apply", "--confirm", previewId], { cwd: dir });
    expect(text.code).toBe(4);
    expect(text.stderr).toContain(`error: The import's requirements changed since preview ${previewId}; nothing was imported; preview again.\nblockers:\n  - ${blockers[0]}\n  - ${blockers[1]}\n  - ${blockers[2]}\nhint: runtime_external_iteration_harness_unavailable: `);
    expect(text.stderr).toMatch(/Step 1 comes first/);

    // Only blockers without a code the kit knows: the hint says to preview again, nothing more.
    server.state.importRequirementsChanged = { blockers: [blockers[0]!, blockers[2]!] };
    const { dir: other, previewId: second } = await previewed();
    const plain = (await cli(sb, ["apply", "--confirm", second, "--json"], { cwd: other })).json<Refusal>().error;
    expect(plain.blockers).toEqual([blockers[0], blockers[2]]);
    expect(plain.hint).toBe("Run `cavelon apply --harness support` again, show the new preview, and confirm its id.");
  });

  it("shows structured blockers as a preview does: code, package file and path, hint and explain", async () => {
    const blockers = ["Agent helper names model gpt-9, which this tenant does not have.", "Tool crm needs a connection."];
    server.state.importRequirementsChanged = {
      blockers,
      blocker_details: [
        { code: "agent_model_unknown", message: blockers[0], path: "agents[0].llm_model", hint: "Choose a model of this tenant." },
        { code: "import_blocked", message: blockers[1], path: null, hint: null },
      ],
    };
    const { dir, previewId } = await previewed();
    const text = await cli(sb, ["apply", "--confirm", previewId], { cwd: dir });
    expect(text.code).toBe(4);
    expect(text.stderr).toContain(`error: The import's requirements changed since preview ${previewId}; nothing was imported; preview again.\nblockers:\n`);
    expect(text.stderr).toMatch(/\n {2}- agent_model_unknown {2}package\/agents\.yaml:\d+ agents\[0\]\.llm_model: Agent helper names model gpt-9/);
    expect(text.stderr).toMatch(/\n {4}hint: Choose a model of this tenant\.\n {4}more: cavelon explain agent_model_unknown\n/);
    expect(text.stderr).toMatch(/\n {2}- import_blocked {2}Tool crm needs a connection\.\n {4}more: cavelon explain import_blocked\n/);
    expect(text.stderr).toMatch(/\nhint: Run `cavelon apply --harness support` again/);

    const { dir: other, previewId: second } = await previewed();
    const error = (await cli(sb, ["apply", "--confirm", second, "--json"], { cwd: other })).json<Refusal & { error: { blocker_details: unknown[] } }>().error;
    expect(error).toMatchObject({ code: "package_requirements_changed", exit_code: 4, blockers });
    expect(error.blocker_details).toEqual([
      { code: "agent_model_unknown", message: blockers[0], path: "agents[0].llm_model", hint: "Choose a model of this tenant.", file: "package/agents.yaml", line: expect.any(Number) },
      { code: "import_blocked", message: blockers[1], path: null, hint: null },
    ]);
    expect(server.state.configs.get(tenant)!.version).toBe(1);
  });

  it("without blocker_details, a 409 keeps its plain blockers and no blocker_details", async () => {
    const blockers = ["Tool crm needs a connection."];
    server.state.importRequirementsChanged = { blockers };
    const { dir, previewId } = await previewed();
    const error = (await cli(sb, ["apply", "--confirm", previewId, "--json"], { cwd: dir })).json<Refusal>().error;
    expect(error.blockers).toEqual(blockers);
    expect(error).not.toHaveProperty("blocker_details");
  });

  it("a 422 for an import blocked when it applies shows its structured blockers too", async () => {
    const { dir, previewId } = await previewed();
    server.state.previewBlockers = ["Agent helper has no model."];
    server.state.previewExtras = { blocker_details: [{ code: "agent_model_missing", message: "Agent helper has no model.", path: "agents[0].llm_model", hint: "Set llm_model." }] };
    try {
      const text = await cli(sb, ["apply", "--confirm", previewId], { cwd: dir });
      expect(text.code).toBe(3);
      expect(text.stderr).toContain(`error: The import's own check refused preview ${previewId} when it applied; nothing was imported.\n`);
      expect(text.stderr).toMatch(/\nhint: Fix what each blocker names, run `cavelon apply --harness support` again/);
      expect(text.stderr).toMatch(/blockers:\n {2}- agent_model_missing {2}package\/agents\.yaml:\d+ agents\[0\]\.llm_model: Agent helper has no model\.\n {4}hint: Set llm_model\./);
    } finally {
      server.state.previewBlockers = [];
      server.state.previewExtras = {};
    }
  });

  it("reads an older instance's 409 without blockers as before", async () => {
    server.state.importRequirementsChanged = {};
    const { dir, previewId } = await previewed();
    const result = await cli(sb, ["apply", "--confirm", previewId, "--json"], { cwd: dir });
    expect(result.code).toBe(4);
    const error = result.json<Refusal>().error;
    expect(error).toMatchObject({ code: "package_requirements_changed", exit_code: 4 });
    expect(error.blockers).toBeUndefined();
    expect(error.message).toBe(`The target changed since preview ${previewId}; nothing was imported.`);
    expect(error.hint).toBe("Run `cavelon apply --harness support` again, show the new preview, and confirm its id.");
    expect((await cli(sb, ["apply", "--confirm", previewId], { cwd: dir })).stderr).not.toMatch(/blockers:/);
  });
});

describe("a Masterloop parent and its iteration solution", () => {
  const ORDER =
    "The order that needs no override: 1. apply the iteration solution; 2. apply the parent; 3. run the parent's loop suite; " +
    "4. activate the iteration solution; 5. activate the parent. `cavelon activate` never forces.";
  const catalog = JSON.parse(read(path.join(CONTRACTS, "meta-error-catalog.json"))) as {
    rule_codes: Array<{ code: string; message: string; hint: string }>;
    api_error_codes: Array<{ code: string; message: string; hint: string }>;
  };
  const entry = (code: string) => [...catalog.rule_codes, ...catalog.api_error_codes].find((e) => e.code === code)!;

  it("apply into a live parent: the hint gives the catalog's sentence and hint, the step, and the order", async () => {
    const dir = await initSolution();
    expect((await cli(sb, ["pull"], { cwd: dir })).code).toBe(0);
    const code = "runtime_draft_iteration_needs_draft_parent";
    const { message, hint } = entry(code);
    // The blocker as the instance's preview words it: its own sentence, then the code with the catalog's.
    server.state.previewBlockers = [`Select valid destination runtime resources and preview again. ${code}: ${message} ${hint}`];
    const blocked = await cli(sb, ["apply", "--json"], { cwd: dir });
    expect(blocked.code).toBe(3);
    const data = blocked.json<{ hint: string }>();
    expect(data.hint.startsWith(`${code}: ${message} ${hint} Step 2 `)).toBe(true);
    expect(data.hint).toMatch(/^runtime_draft_iteration_needs_draft_parent: The bound iteration solution is a draft, and the parent this import writes is active or paused\. Activate the iteration solution first, or import into a draft parent\. Step 2 binds a draft iteration only into a draft parent/);
    expect(data.hint.endsWith(ORDER)).toBe(true);
    const text = await cli(sb, ["apply"], { cwd: dir });
    expect(text.stdout).toContain(`hint: ${data.hint}`);
    expect(server.state.requests.some((r) => r.path === "/api/v1/agent-graph/import")).toBe(false);

    // An unbound or missing iteration solution points at step 1.
    server.state.previewBlockers = ["Select valid destination runtime resources and preview again. runtime_external_iteration_harness_unavailable"];
    const unbound = (await cli(sb, ["apply", "--json"], { cwd: dir })).json<{ hint: string }>();
    expect(unbound.hint).toContain(entry("runtime_external_iteration_harness_unavailable").hint);
    expect(unbound.hint).toMatch(/Step 1 comes first/);

    // Any other blocker gets no pair hint.
    server.state.previewBlockers = ["Tool crm needs a connection."];
    expect((await cli(sb, ["apply", "--json"], { cwd: dir })).json<{ hint?: string }>().hint).toBeUndefined();
  });

  it("activate of the parent before its iteration: the hint points at step 4, and nothing is forced", async () => {
    await cli(sb, ["harness", "new", "counter-parent"]);
    const { message, hint } = entry("masterloop_iteration_harness_draft");
    server.state.ready = false;
    server.state.readinessBlockers = [{
      key: "masterloop",
      label: "Every Masterloop passes its compatibility check",
      state: "action_required",
      detail: `"loop" does not pass its compatibility check: ${message} (Solution "Counter iteration") ${hint}`,
      href: "/agents",
    }];
    server.state.requests.length = 0;
    const refused = await cli(sb, ["activate", "--harness", "counter-parent", "--json"]);
    expect(refused.code).toBe(3);
    const data = refused.json<{ activated: boolean; hint: string }>();
    expect(data.activated).toBe(false);
    expect(data.hint).toMatch(/^masterloop_iteration_harness_draft: .* Step 4 comes before step 5/);
    expect(data.hint.endsWith(ORDER)).toBe(true);
    expect(server.state.requests.some((r) => r.path.endsWith("/activate"))).toBe(false);

    server.state.readinessBlockers = undefined;
    expect((await cli(sb, ["activate", "--harness", "counter-parent", "--json"])).json<{ hint?: string }>().hint).toBeUndefined();
  });

  it("explain adds the order to the catalog's entry", async () => {
    const dir = await initSolution();
    const result = await cli(sb, ["explain", "runtime_draft_iteration_needs_draft_parent", "--json"], { cwd: dir });
    expect(result.code).toBe(0);
    const data = result.json<{ kind: string; hint: string; kit_hint: string }>();
    expect(data).toMatchObject({ kind: "api", hint: entry("runtime_draft_iteration_needs_draft_parent").hint });
    expect(data.kit_hint.endsWith(ORDER)).toBe(true);
    expect((await cli(sb, ["explain", "runtime_draft_iteration_needs_draft_parent"], { cwd: dir })).stdout).toMatch(/order:\s+Step 2/);
  });
});

describe("whoami", () => {
  it("shows the token's name and expiry, and warns within a week", async () => {
    const soon = sandbox();
    try {
      const expires = new Date(Date.now() + 3 * 86_400_000 + 3_600_000).toISOString();
      await login(soon, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant, tokenName: "laptop", expiresAt: expires }));
      const result = await cli(soon, ["whoami", "--json"]);
      expect(result.code).toBe(0);
      const data = result.json<{ credential: Record<string, unknown>; warnings: string[] }>();
      expect(data.credential).toMatchObject({ name: "laptop", expires_at: expires, expires_in_days: 3, may_activate: false, published: true });
      expect(data.warnings.join()).toMatch(/"laptop" expires in 3 days/);
      const text = await cli(soon, ["whoami"]);
      expect(text.stdout).toMatch(/expires:\s+\S+ \(in 3 days\)/);
      expect(text.stderr).toMatch(/warning: The personal access token "laptop" expires in 3 days/);
    } finally {
      soon.cleanup();
    }
    const later = await cli(sb, ["whoami", "--json"]);
    expect(later.json<{ warnings?: string[] }>().warnings).toBeUndefined();
  });

  it("names an API key and says when an older instance does not publish the expiry", async () => {
    const keyed = sandbox();
    try {
      await login(keyed, server.url, server.addToken({ kind: "key", tenantIds: [tenant], tokenName: "ci" }));
      expect((await cli(keyed, ["whoami"])).stdout).toMatch(/acting as:\s+the tenant API key "ci"/);
      server.state.servePrincipal = false;
      const old = await cli(keyed, ["whoami"]);
      expect(old.stdout).toMatch(/expires:\s+not published by this instance/);
    } finally {
      server.state.servePrincipal = true;
      keyed.cleanup();
    }
  });
});
