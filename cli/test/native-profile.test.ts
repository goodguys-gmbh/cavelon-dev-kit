import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { assertNativeWorkspace, loadNativeRuntime, nativeEntryHash, type NativeProfile } from "../src/native-approval/profile.js";
import { KIT_VERSION } from "../src/version.js";

let temp: string;
beforeEach(async () => { temp = await fs.mkdtemp(path.join(os.tmpdir(), "cavelon-native-profile-")); });
afterEach(async () => { await fs.rm(temp, { recursive: true, force: true }); });

async function project(client: "opencode" | "pi", name = "project with spaces") {
  const root = path.join(temp, name);
  const dir = path.join(root, client === "pi" ? ".pi" : ".opencode", "cavelon");
  await fs.mkdir(dir, { recursive: true });
  const configFile = client === "pi" ? "../mcp.json" : "../../opencode.jsonc";
  const entry = client === "pi" ? { command: "cavelon", args: ["mcp"], enabled: false } : { type: "local", command: ["cavelon", "mcp"], enabled: false };
  const file = path.resolve(dir, configFile);
  await fs.writeFile(file, JSON.stringify({ [client === "pi" ? "mcpServers" : "mcp"]: { cavelon: entry } }));
  const profile: NativeProfile = { format: 2, client, version: KIT_VERSION, configFile, entryHash: nativeEntryHash(entry), scope: "project", projectRoot: "../.." };
  const profileFile = path.join(dir, "profile.json");
  await fs.writeFile(profileFile, JSON.stringify(profile));
  return { root, dir, file, profile, profileFile };
}

it.each(["opencode", "pi"] as const)("loads %s's project profile after the whole clone moves", async client => {
  const p = await project(client);
  const moved = path.join(temp, "another clone");
  await fs.rename(p.root, moved);
  const profileFile = path.join(moved, path.relative(p.root, p.profileFile));
  const runtime = await loadNativeRuntime(profileFile, client);
  expect(runtime.scope).toBe("project");
  expect(runtime.projectRoot).toBe(await fs.realpath(moved));
  expect(runtime.command).toMatchObject({ command: "cavelon", args: ["mcp"] });
  await expect(assertNativeWorkspace(runtime, moved)).resolves.toBeUndefined();
  await expect(assertNativeWorkspace(runtime, temp)).rejects.toThrow(/matching project/);
  expect(await fs.readFile(profileFile, "utf8")).not.toContain(temp);
});

it("rejects absolute, escaping and unknown-version portable profile fields", async () => {
  const p = await project("opencode");
  for (const override of [{ configFile: p.file }, { projectRoot: p.root }, { configFile: "../../../outside.json" },
    { configFile: "C:outside.json" }, { configFile: "..\\mcp.json" }, { format: 3 }, { scope: "user" }]) {
    await fs.writeFile(p.profileFile, JSON.stringify({ ...p.profile, ...override }));
    await expect(loadNativeRuntime(p.profileFile, "opencode")).rejects.toThrow(/profile|outside/);
  }
});

// Windows symlink creation requires host privileges; its move/path cases run above.
it.skipIf(process.platform === "win32")("a portable profile cannot bind a symlinked config outside its project", async () => {
  const p = await project("opencode");
  const outside = path.join(temp, "outside.json");
  await fs.rename(p.file, outside);
  await fs.symlink(outside, p.file);
  await expect(loadNativeRuntime(p.profileFile, "opencode")).rejects.toThrow(/outside/);
});

it("legacy absolute user profiles remain valid and cannot adopt a changed or enabled entry", async () => {
  const p = await project("pi");
  const legacy = { ...p.profile, format: undefined, scope: "user", configFile: p.file, projectRoot: undefined };
  await fs.writeFile(p.profileFile, JSON.stringify(legacy));
  expect((await loadNativeRuntime(p.profileFile, "pi")).scope).toBe("user");
  await fs.writeFile(p.file, JSON.stringify({ mcpServers: { cavelon: { command: "personal", args: [], enabled: false } } }));
  await expect(loadNativeRuntime(p.profileFile, "pi")).rejects.toThrow(/changed/);
});
