import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { CONTRACTS, startFakeServer, type FakeServer } from "./fake-server.js";
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

describe("init", () => {
  it("creates its own files and folders and the uncommitted .cavelon/", async () => {
    const dir = await initSolution();
    const project = parse(read(path.join(dir, "cavelon.yaml")));
    expect(project).toMatchObject({ instance: server.url, tenant, harness: "support", package_version: "v3", layout: { package: "package", items: { test_suites: "tests" } } });
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

    const result = await cli(sb, ["init", "--instance", server.url, "--tenant", tenant, "--agents", "claude,codex,cursor", "--agents", "copilot", "--json"], { cwd: dir });
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
    expect(data.imported.files.written).toEqual([
      "package/harnesses.yaml",
      "package/manifest.yaml",
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
    expect(valid.json()).toMatchObject({ valid: true, schema_version: "v3", errors: 0, warnings: 0, sections: 5 });
    expect(server.state.requests).toEqual([]);

    // The same file again changes nothing.
    const again = await cli(sb, ["init", "--from", "../counter-parent.json", "--json"], { cwd: dir });
    expect(again.code, again.stdout).toBe(0);
    expect(again.json<{ imported: { files: { written: string[]; unchanged: string[] } } }>().imported.files).toMatchObject({ written: [] });

    // apply creates the draft the env file names, under the package's harness name.
    const applied = await cli(sb, ["apply", "--env", "test", "--json"], { cwd: dir });
    expect(applied.code, applied.stdout).toBe(0);
    expect(server.state.harnesses.find((h) => h.slug === "blueprint-counter")).toMatchObject({ name: "Blueprint: sandbox-free counter", status: "draft" });
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

  it("warns when an agent is given a knowledge base but no search tool reaches it", async () => {
    const dir = await initSolution();
    await cli(sb, ["pull"], { cwd: dir });
    const skillsFile = path.join(dir, "package", "skills.yaml");
    const agentsFile = path.join(dir, "package", "agents.yaml");
    const skills = parse(read(skillsFile)) as Array<Record<string, unknown>>;
    expect(skills[0]).toMatchObject({ slug: "faq", tool_assignments: [{ tool_slug: "search_documents" }] });
    expect((await cli(sb, ["validate", "--offline", "--json"], { cwd: dir })).json()).toMatchObject({ warnings: 0 });

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
      'The agent "helper" is given the knowledge base "Handbook" through the skill "faq", but no search tool reaches it, so it cannot search it: add search_documents to the skill\'s tool_assignments.',
    );
    expect(result.findings[0]!.hint).toMatch(/tool_slug: search_documents/);
    expect(result.findings[0]!.docs).toMatch(/builtin-tools#binding-knowledge-bases-to-search_documents$/);

    // The agent's own assignment of the tool reaches it as well.
    const agents = parse(read(agentsFile)) as Array<Record<string, unknown>>;
    agents[0]!.tool_assignments = [{ tool_slug: "search_documents" }];
    writeFileSync(agentsFile, stringify(agents));
    expect((await cli(sb, ["validate", "--offline", "--json"], { cwd: dir })).json()).toMatchObject({ warnings: 0, findings: [] });

    // An agent's tool assignment that names knowledge bases on another tool is no search either.
    agents[0]!.tool_assignments = [{ tool_slug: "crm", config_overrides: { knowledge_base_names: ["Handbook"] } }];
    agents[0]!.skill_assignments = [];
    writeFileSync(agentsFile, stringify(agents));
    const own = await cli(sb, ["validate", "--offline"], { cwd: dir });
    expect(own.stdout).toMatch(
      /warning knowledge_base_without_search_tool {2}package\/agents\.yaml:\d+ agents\[0\]\.tool_assignments\[0\]\.config_overrides\.knowledge_base_names: The agent "helper" is given the knowledge base "Handbook", but no search tool reaches it/,
    );

    // A skill this package does not carry may bring the tool: no warning.
    agents[0]!.skill_assignments = [{ skill_slug: "tenant-wide-search" }];
    writeFileSync(agentsFile, stringify(agents));
    expect((await cli(sb, ["validate", "--offline", "--json"], { cwd: dir })).json()).toMatchObject({ warnings: 0 });

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

describe("validate on an instance whose schema changes under one version", () => {
  /** The section a development build gains while it keeps reporting v0.0.0-dev. */
  const gainNotes = (schema: { properties: Record<string, unknown> }) => {
    schema.properties.deployment_notes = { type: "object", additionalProperties: true };
  };
  const later = (minutes: number) => () => new Date(Date.now() + minutes * 60_000);
  let own: Sandbox;

  type Validated = { warnings: number; findings: Array<{ code: string }>; schema: { source: string; instance_version: string; fetched_at: string; etag: string | null; sha256: string; stale: boolean } };

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
    expect((await cli(own, ["validate", "--json"], { cwd: dir })).json<Validated>()).toMatchObject({ warnings: 1, schema: { source: "cache", sha256: first.schema.sha256 } });
    expect(server.state.requests.filter((r) => r.path === "/api/v1/meta/package-schema")).toEqual([]);

    // Offline, an old copy is used and said to be old.
    const offline = (await cli(own, ["validate", "--offline", "--json"], { cwd: dir, now: later(2) })).json<Validated>();
    expect(offline).toMatchObject({ warnings: 1, schema: { source: "cache", stale: true } });

    const after = await cli(own, ["validate", "--json", "--verbose"], { cwd: dir, now: later(2) });
    expect(after.code, after.stdout).toBe(0);
    const second = after.json<Validated>();
    expect(second).toMatchObject({ warnings: 0, findings: [], schema: { source: "instance", instance_version: "v0.0.0-dev", stale: false } });
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
    expect(same).toMatchObject({ warnings: 1, schema: { source: "instance", etag: first.schema.etag, sha256: first.schema.sha256 } });
    const asked = server.state.requests.filter((r) => r.path === "/api/v1/meta/package-schema");
    expect(asked.map((r) => r.headers["if-none-match"])).toEqual([first.schema.etag]);

    server.state.packageSchemaEdit = gainNotes;
    const changed = (await cli(own, ["validate", "--json"], { cwd: dir, now: later(4) })).json<Validated>();
    expect(changed).toMatchObject({ warnings: 0, schema: { source: "instance" } });
    expect(changed.schema.etag).not.toBe(first.schema.etag);
  });

  it("keeps a release's cached schema: its version changes with its schema", async () => {
    server.state.capsPatch = { instance: { version: "v1.4.0", phase: "ga" } };
    const dir = await solutionIn(own);
    server.state.packageSchemaEdit = gainNotes;
    const result = (await cli(own, ["validate", "--json"], { cwd: dir, now: later(30) })).json<Validated>();
    expect(result).toMatchObject({ warnings: 1, schema: { source: "cache", instance_version: "v1.4.0", stale: false } });
  });

  it("uses a development build's old copy, with a warning, when the instance cannot be read", async () => {
    const dir = await solutionIn(own);
    server.state.packageSchemaEdit = () => {
      throw new Error("schema store unavailable");
    };
    const result = await cli(own, ["validate", "--json"], { cwd: dir, now: later(2) });
    expect(result.code, result.stdout).toBe(0);
    const data = result.json<Validated & { warnings: unknown }>();
    expect(data).toMatchObject({ findings: [expect.objectContaining({ code: "package_section_unknown" })], schema: { source: "cache", stale: true } });
    expect(result.stdout + result.stderr).toMatch(/Could not read the package schema again from the instance \(.+\); using the copy cached at \S+ for development build v0\.0\.0-dev\./);
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

    // The files change after the preview; the import still sends what was previewed.
    const agentsFile = path.join(dir, "package", "agents.yaml");
    writeFileSync(agentsFile, read(agentsFile).replace("temperature: 0.2", "temperature: 0.5"));
    server.state.requests.length = 0;
    const confirmed = await cli(sb, ["apply", "--confirm", data.preview_id, "--json"], { cwd: dir });
    expect(confirmed.code, confirmed.stdout).toBe(0);
    expect(confirmed.json<{ applied: boolean; warnings: string[] }>()).toMatchObject({ applied: true });
    expect(confirmed.json<{ warnings: string[] }>().warnings.join()).toMatch(/files changed since this preview/);
    const sent = server.state.requests.find((r) => r.path === "/api/v1/agent-graph/import")!.body as Record<string, any>;
    expect(sent.preview_id).toBe(data.preview_id);
    expect(sent.package.agents[0].temperature).toBe(0.2);
    expect(existsSync(stored)).toBe(false);
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

  it("creates the draft solution the env file names, and binds runtime requirements from it", async () => {
    const dir = await pulled();
    const binding = "8f2b7c1e-1111-4222-8333-444455556666";
    writeFileSync(path.join(dir, "env", "test.yaml"), `harness: support-test\nruntime_bindings:\n  workspace: ${binding}\n`);
    const result = await cli(sb, ["apply", "--env", "test", "--json"], { cwd: dir });
    expect(result.code, result.stdout).toBe(0);
    const data = result.json<{ harness: { slug: string; created: boolean }; env: string; warnings: string[] }>();
    expect(data).toMatchObject({ env: "test", harness: { slug: "support-test", created: true } });
    expect(data.warnings.join()).toMatch(/Created the draft solution Support \(support-test\)/);
    const created = server.state.harnesses.find((h) => h.slug === "support-test")!;
    expect(created.status).toBe("draft");
    // The draft takes the package's harness name, not the slug.
    expect(created.name).toBe("Support");
    const sent = server.state.requests.filter((r) => r.path === "/api/v1/agent-graph/import/preview").pop()!.body as Record<string, any>;
    expect(sent).toMatchObject({ harness_id: created.id, runtime_bindings: { workspace: binding }, mode: "overwrite" });

    // A harness named on the command line is never created.
    const missing = await cli(sb, ["apply", "--harness", "nope", "--json"], { cwd: dir });
    expect(missing.code).toBe(1);
    expect(missing.json<{ error: { code: string } }>().error.code).toBe("solution_not_found");
  });

  it("names a created draft after the package's harness with that slug, and after the slug when the package has none", async () => {
    const dir = await pulled();
    const harnessesFile = path.join(dir, "package", "harnesses.yaml");
    writeFileSync(
      harnessesFile,
      "- slug: support-parent\n  name: Support parent\n  status: draft\n- slug: support-loop\n  name: Support loop\n  status: draft\n",
    );
    writeFileSync(path.join(dir, "env", "test.yaml"), "harness: support-loop\n");
    const named = await cli(sb, ["apply", "--env", "test", "--json"], { cwd: dir });
    expect(named.code, named.stdout).toBe(0);
    expect(server.state.harnesses.find((h) => h.slug === "support-loop")!.name).toBe("Support loop");
    const posted = server.state.requests.filter((r) => r.path === "/api/v1/harnesses" && r.method === "POST").pop()!.body;
    expect(posted).toEqual({ slug: "support-loop", name: "Support loop" });

    // Several harnesses and none with the slug, or none at all: the slug stays the name.
    writeFileSync(path.join(dir, "env", "test.yaml"), "harness: support-other\n");
    expect((await cli(sb, ["apply", "--env", "test", "--json"], { cwd: dir })).code).toBe(0);
    expect(server.state.harnesses.find((h) => h.slug === "support-other")!.name).toBe("support-other");
    rmSync(harnessesFile);
    writeFileSync(path.join(dir, "env", "test.yaml"), "harness: support-bare\n");
    const bare = await cli(sb, ["apply", "--env", "test", "--json"], { cwd: dir });
    expect(bare.code, bare.stdout).toBe(0);
    expect(server.state.harnesses.find((h) => h.slug === "support-bare")!.name).toBe("support-bare");
    expect(bare.json<{ warnings: string[] }>().warnings.join()).toMatch(/Created the draft solution support-bare \(support-bare\)/);
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
    expect(unknown.json<{ error: { hint: string } }>().error.hint).toMatch(/agent_pipeline_fanout_unsupported/);
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
