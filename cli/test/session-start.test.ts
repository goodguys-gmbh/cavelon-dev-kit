import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sandbox, type Sandbox } from "./helpers.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(ROOT, "plugin", "scripts", "session-start.sh");
let sb: Sandbox;

beforeEach(() => { sb = sandbox(); });
afterEach(() => sb.cleanup());

// This exercises the POSIX hook; native Windows without Git Bash uses the shared skill preflight.
describe.skipIf(process.platform === "win32")("Claude session readiness notice", () => {
  function run(folder: string, programs: string[] = [], project?: string) {
    const bin = path.join(sb.home, "bin");
    mkdirSync(bin, { recursive: true });
    for (const name of programs) {
      // A startup notice must not launch a second server, download a package or read credentials.
      writeFileSync(path.join(bin, name), `#!/bin/sh\nprintf invoked > '${sb.home}/unexpected-invocation'\nexit 1\n`, { mode: 0o755 });
    }
    return spawnSync("/bin/sh", [SCRIPT], {
      cwd: folder,
      env: { ...sb.env, PATH: bin, ...(project ? { CLAUDE_PROJECT_DIR: project } : {}) },
      input: JSON.stringify({ hook_event_name: "SessionStart", source: "startup", session_id: "synthetic-session" }),
      encoding: "utf8",
      timeout: 2000,
    });
  }

  it("warns about missing launch prerequisites and supplies a repair step", () => {
    writeFileSync(path.join(sb.home, "cavelon.yaml"), "name: example\n");
    const result = run(sb.home);
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.systemMessage).toMatch(/neither.*cavelon.*npx/i);
    expect(output.systemMessage).toContain("/mcp");
    expect(output.hookSpecificOutput).toMatchObject({ hookEventName: "SessionStart", additionalContext: expect.any(String) });
    expect(existsSync(path.join(sb.home, "unexpected-invocation"))).toBe(false);
  });

  it.each([["cavelon"], ["npx"], ["cavelon", "npx"]])("requires an actual session check with %j available, without executing it", (...programs) => {
    writeFileSync(path.join(sb.home, "cavelon.yaml"), "name: example\n");
    const result = run(sb.home, programs);
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.systemMessage).toMatch(/not.*verified/i);
    expect(output.hookSpecificOutput.additionalContext).toContain("whoami");
    expect(existsSync(path.join(sb.home, "unexpected-invocation"))).toBe(false);
  });

  it("finds a solution above the current directory and honors the client's project directory", () => {
    const project = path.join(sb.home, "solution with spaces");
    const nested = path.join(project, "tests", "fixtures");
    mkdirSync(nested, { recursive: true });
    writeFileSync(path.join(project, "cavelon.yaml"), "name: example\n");
    expect(JSON.parse(run(nested, ["cavelon"]).stdout).systemMessage).toBeTruthy();
    expect(JSON.parse(run(sb.home, ["cavelon"], project).stdout).systemMessage).toBeTruthy();
  });

  it("recognizes a repository whose solutions are in immediate child folders", () => {
    const child = path.join(sb.home, "solutions", "support");
    mkdirSync(child, { recursive: true });
    writeFileSync(path.join(child, "cavelon.yaml"), "name: support\n");
    expect(JSON.parse(run(sb.home, ["cavelon"]).stdout).systemMessage).toBeTruthy();
  });

  it("stays silent in unrelated projects", () => {
    const result = run(sb.home);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });
});

it("registers a bounded session hook through the plugin's default hooks file", () => {
  const config = JSON.parse(readFileSync(path.join(ROOT, "plugin", "hooks", "hooks.json"), "utf8"));
  const hooks = config.hooks.SessionStart.flatMap((entry: { hooks: unknown[] }) => entry.hooks);
  expect(hooks).toEqual([expect.objectContaining({ type: "command", timeout: 5, command: expect.stringContaining("session-start.sh") })]);
});
