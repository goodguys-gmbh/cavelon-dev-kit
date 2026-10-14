import { mkdirSync, readFileSync, writeFileSync, statSync, symlinkSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { cli, sandbox, type Sandbox } from "./helpers.js";

let sb: Sandbox;
beforeEach(() => { sb = sandbox(); });
afterEach(() => sb.cleanup());
const settings = () => path.join(sb.env.CAVELON_CONFIG_DIR!, "automation.json");

it("installer follow-up without a terminal does not enable YOLO or change agents", async () => {
  const result = await cli(sb, ["setup", "--installer", "--json"]);
  expect(result.code, result.stderr).toBe(0);
  expect(result.json()).toMatchObject({ updated_agents: false, mcp_mode: "standard", mode_changed: false });
  expect(() => readFileSync(settings())).toThrow();
});

it("saves and disables the personal MCP mode without login or agent setup", async () => {
  mkdirSync(path.join(sb.home, ".cursor"));
  const first = await cli(sb, ["setup", "--mcp-mode", "yolo", "--yes", "--json"]);
  expect(first.code, first.stderr).toBe(0);
  expect(first.json()).toMatchObject({ mcp_mode: "yolo", mode_changed: true });
  expect(JSON.parse(readFileSync(settings(), "utf8"))).toMatchObject({ format: 1, mcp_mode: "yolo" });
  expect(() => readFileSync(path.join(sb.home, ".cursor", "mcp.json"))).toThrow();
  if (process.platform !== "win32") expect(statSync(settings()).mode & 0o777).toBe(0o600);
  const disabled = await cli(sb, ["setup", "--mcp-mode", "standard", "--yes", "--json"]);
  expect(disabled.code, disabled.stderr).toBe(0);
  expect(disabled.json()).toMatchObject({ mcp_mode: "standard", mode_changed: true });
});

it("requires an explicit answer or --yes to change the persistent mode", async () => {
  const result = await cli(sb, ["setup", "--mcp-mode", "yolo", "--json"]);
  expect(result.code).not.toBe(0);
  expect(() => readFileSync(settings())).toThrow();
});

it.each([{ CI: "true" }, { CODEX_THREAD_ID: "agent" }])("never prompts for installer choices in CI or an agent terminal (%j)", async env => {
  const result = await cli(sb, ["setup", "--installer"], { env, tty: true });
  expect(result.code, result.stderr).toBe(0);
  expect(result.stderr).not.toContain("[y]");
  expect(() => readFileSync(settings())).toThrow();
});

it("rejects conflicting choices before changing settings", async () => {
  const result = await cli(sb, ["setup", "--installer", "--update", "--skip-update", "--mcp-mode", "yolo", "--json"]);
  expect(result.code).toBe(2);
  expect(() => readFileSync(settings())).toThrow();
});

it("package-manager users can choose YOLO through setup --update without the installer", async () => {
  mkdirSync(path.join(sb.home, ".cursor"));
  const result = await cli(sb, ["setup", "--update", "--agents", "cursor"], { tty: true, stdin: "y\ny\n" });
  expect(result.code, result.stderr).toBe(0);
  expect(result.stderr).toContain("YOLO for new agent sessions");
  expect(result.stderr).not.toContain("Log in");
  expect(JSON.parse(readFileSync(settings(), "utf8")).mcp_mode).toBe("yolo");
});

it("the installer asks separately for skill refresh and YOLO, and Enter preserves the mode", async () => {
  const first = await cli(sb, ["setup", "--installer"], { tty: true, stdin: "n\ny\n" });
  expect(first.code, first.stderr).toBe(0);
  expect(first.stderr).toContain("plugins and skills");
  expect(first.stderr).toContain("YOLO");
  expect(JSON.parse(readFileSync(settings(), "utf8")).mcp_mode).toBe("yolo");
  const second = await cli(sb, ["setup", "--installer"], { tty: true, stdin: "n\n\n" });
  expect(second.code, second.stderr).toBe(0);
  expect(JSON.parse(readFileSync(settings(), "utf8")).mcp_mode).toBe("yolo");
  const third = await cli(sb, ["setup", "--installer"], { tty: true, stdin: "n\nn\n" });
  expect(third.code, third.stderr).toBe(0);
  expect(JSON.parse(readFileSync(settings(), "utf8")).mcp_mode).toBe("standard");
});

it("unattended follow-up can explicitly update skills and enable YOLO without login", async () => {
  mkdirSync(path.join(sb.home, ".cursor"));
  const result = await cli(sb, ["setup", "--installer", "--update", "--mcp-mode", "yolo", "--non-interactive", "--json"]);
  expect(result.code, result.stderr).toBe(0);
  expect(result.json()).toMatchObject({ updated_agents: true, mcp_mode: "yolo" });
  expect(readFileSync(path.join(sb.home, ".cursor", "skills", "cavelon-loop", "SKILL.md"), "utf8")).toContain("cavelon:generated");
  expect(result.stderr).not.toContain("Log in");
});

it.each(["not json", '{"format":2,"mcp_mode":"yolo"}', '{"format":1,"mcp_mode":true}'])("refuses to overwrite unrecognized private mode settings (%s)", async content => {
  mkdirSync(sb.env.CAVELON_CONFIG_DIR!, { recursive: true });
  writeFileSync(settings(), content);
  const result = await cli(sb, ["setup", "--mcp-mode", "yolo", "--yes", "--json"]);
  expect(result.code).not.toBe(0);
  expect(readFileSync(settings(), "utf8")).toBe(content);
});

it.skipIf(process.platform === "win32")("does not follow a mode-file symlink into a repository", async () => {
  mkdirSync(sb.env.CAVELON_CONFIG_DIR!, { recursive: true });
  const other = path.join(sb.home, "repository-preference.json");
  writeFileSync(other, '{"format":1,"mcp_mode":"yolo"}');
  symlinkSync(other, settings());
  const result = await cli(sb, ["setup", "--mcp-mode", "standard", "--yes", "--json"]);
  expect(result.code).not.toBe(0);
  expect(readFileSync(other, "utf8")).toContain('"yolo"');
});
