import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { afterEach, expect, it } from "vitest";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixtures = path.join(repo, "cli/test/fixtures");
const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it("provisions the locked client and transitive dependency without consulting a changing registry", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cavelon-provision-"));
  temporary.push(dir);
  const scripts = path.join(dir, ".github/scripts");
  const locks = path.join(dir, "cli/test/fixtures/coding-client-locks");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(locks, { recursive: true });
  copyFileSync(path.join(repo, ".github/scripts/provision-coding-client.mjs"), path.join(scripts, "provision-coding-client.mjs"));
  const { tar } = await import(pathToFileURL(path.join(repo, "packaging/plugins.mjs")).href) as {
    tar(entries: Map<string, Buffer>): Buffer;
  };
  const client = "cavelon-fixture-client";
  const dependency = "cavelon-fixture-dependency";
  const packages: Record<string, any> = { "": { dependencies: { [client]: "1.0.0" } } };
  for (const name of [client, dependency]) {
    const manifest = { name, version: "1.0.0", ...(name === client ? { dependencies: { [dependency]: "^1.0.0" } } : {}) };
    const bytes = gzipSync(tar(new Map([["package/package.json", Buffer.from(JSON.stringify(manifest))]])));
    const archive = path.join(dir, `${name}.tgz`);
    writeFileSync(archive, bytes);
    packages[`node_modules/${name}`] = {
      version: manifest.version, resolved: pathToFileURL(archive).href,
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
      ...(name === client ? { dependencies: manifest.dependencies } : {}),
    };
  }
  const lockBytes = JSON.stringify({ lockfileVersion: 3, requires: true, packages });
  writeFileSync(path.join(locks, "cline.json"), lockBytes);
  writeFileSync(path.join(locks, "../coding-client-runtimes.json"), JSON.stringify({ cline: { package: client, version: "1.0.0" } }));
  const runtime = path.join(dir, "runtime");
  const result = spawnSync(process.execPath, [path.join(scripts, "provision-coding-client.mjs"), "cline"], {
    encoding: "utf8", timeout: 15_000,
    // An empty cache and offline mode make any fresh registry resolution fail.
    env: { ...process.env, CAVELON_CLIENT_RUNTIME: runtime, npm_config_cache: path.join(dir, "cache"), npm_config_offline: "true", npm_config_registry: "http://127.0.0.1:1" },
  });
  expect(result.status, result.stderr).toBe(0);
  for (const name of [client, dependency]) {
    expect(JSON.parse(readFileSync(path.join(runtime, "node_modules", name, "package.json"), "utf8")).version).toBe("1.0.0");
  }
  expect(readFileSync(path.join(runtime, "package-lock.json"), "utf8")).toBe(lockBytes);
  const evidence = JSON.parse(readFileSync(path.join(dir, `.wt/coding-client-runtime/cline-${process.platform}-${process.arch}-provision.json`), "utf8"));
  expect(evidence.dependencyLockSha256).toBe(createHash("sha256").update(lockBytes).digest("hex"));
});

it("keeps every npm client pin and its complete portable lock in agreement", () => {
  const pins = JSON.parse(readFileSync(path.join(fixtures, "coding-client-runtimes.json"), "utf8"));
  for (const [client, pin] of Object.entries(pins) as [string, { package?: string; version: string }][]) {
    if (!pin.package) continue;
    const lock = JSON.parse(readFileSync(path.join(fixtures, "coding-client-locks", `${client}.json`), "utf8"));
    expect(lock.lockfileVersion).toBe(3);
    expect(lock.packages[""].dependencies).toEqual({ [pin.package]: pin.version });
    expect(lock.packages[`node_modules/${pin.package}`].version).toBe(pin.version);
    for (const [name, entry] of Object.entries(lock.packages) as [string, any][]) {
      if (!name) continue;
      expect(entry.resolved, `${client}: ${name}`).toMatch(/^https:\/\/registry\.npmjs\.org\//);
      expect(entry.integrity, `${client}: ${name}`).toMatch(/^sha512-/);
    }
    const platforms = new Set(Object.values(lock.packages).flatMap((entry: any) => entry.os ?? []));
    for (const platform of ["linux", "darwin", "win32"]) expect(platforms.has(platform), `${client}: ${platform}`).toBe(true);
  }
});
