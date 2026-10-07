import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, describe, expect, it } from "vitest";
import { buildBundle, executableName, PLATFORMS, type BundleManifest } from "../../packaging/bundle/build-bundle.mjs";
import { SUPPORTED_CONTRACTS } from "../src/version.js";

/**
 * The offline bundle (docs/offline-bundle.md): the same inputs give the same
 * tarball, its manifest validates against the schema in contracts/ and lists
 * every file it carries, its MCP entries and plugin packages start the
 * cavelon on the PATH, and install.sh installs from its bin folder without a
 * network.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const VERSION = (JSON.parse(readFileSync(path.join(ROOT, "cli", "package.json"), "utf8")) as { version: string }).version;
const SCHEMA = JSON.parse(readFileSync(path.join(ROOT, "contracts", "offline-bundle-manifest.schema.json"), "utf8"));
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(SCHEMA);

const temp = mkdtempSync(path.join(os.tmpdir(), "cavelon-bundle-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

/** A folder of stand-in executables: each prints the version, as a real one does. */
function executables(name: string, only = PLATFORMS): string {
  const dir = path.join(temp, name);
  mkdirSync(dir, { recursive: true });
  for (const platform of only) writeFileSync(path.join(dir, executableName(platform)), `#!/bin/sh\necho ${VERSION}\n`, { mode: 0o755 });
  return dir;
}

interface TarEntry {
  name: string;
  type: string;
  mode: number;
  mtime: number;
  uid: number;
  gid: number;
  content: Buffer;
}

function readTar(gz: Buffer): TarEntry[] {
  const bytes = gunzipSync(gz);
  const entries: TarEntry[] = [];
  const field = (block: Buffer, start: number, length: number) => {
    const raw = block.subarray(start, start + length);
    const end = raw.indexOf(0);
    return raw.subarray(0, end === -1 ? length : end).toString("utf8");
  };
  const octal = (block: Buffer, start: number, length: number) => parseInt(field(block, start, length).trim() || "0", 8);
  let pax: string | undefined;
  for (let at = 0; at + 512 <= bytes.length; ) {
    const block = bytes.subarray(at, at + 512);
    if (block.every((b) => b === 0)) break;
    const size = octal(block, 124, 12);
    const content = Buffer.from(bytes.subarray(at + 512, at + 512 + size));
    at += 512 + Math.ceil(size / 512) * 512;
    const type = field(block, 156, 1);
    if (type === "x") {
      pax = /^\d+ path=(.*)\n$/s.exec(content.toString("utf8"))?.[1];
      continue;
    }
    const prefix = field(block, 345, 155);
    const name = pax ?? (prefix ? `${prefix}/${field(block, 0, 100)}` : field(block, 0, 100));
    pax = undefined;
    entries.push({ name, type, mode: octal(block, 100, 8), mtime: octal(block, 136, 12), uid: octal(block, 108, 8), gid: octal(block, 116, 8), content });
  }
  return entries;
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** A copy of what the builder reads from the repository, to change without touching it. */
function sourceTree(name: string): string {
  const dir = path.join(temp, name);
  for (const p of ["plugin", ".claude-plugin", ".agents", "install.sh", "install.ps1", "LICENSE", "packaging/bundle/README.md"]) {
    cpSync(path.join(ROOT, p), path.join(dir, p), { recursive: true });
  }
  return dir;
}

describe("the offline bundle", () => {
  const bins = executables("release");
  const options = { version: VERSION, contracts: SUPPORTED_CONTRACTS, executablesDir: bins };
  const bundle = buildBundle(options);
  const entries = readTar(bundle.tarball);
  const top = `cavelon-bundle-${VERSION}`;
  const file = (relative: string) => entries.find((e) => e.name === `${top}/${relative}`);

  it("is the same bytes for the same inputs, and differs when an input does", () => {
    expect(buildBundle(options).tarball.equals(bundle.tarball)).toBe(true);
    const commit = buildBundle({ ...options, commit: "0".repeat(40) });
    expect(commit.tarball.equals(bundle.tarball)).toBe(false);
    const changed = executables("changed");
    writeFileSync(path.join(changed, executableName("linux-x64")), "#!/bin/sh\necho other\n");
    expect(buildBundle({ ...options, executablesDir: changed }).tarball.equals(bundle.tarball)).toBe(false);
  });

  it("holds no time, owner or system of the machine that built it", () => {
    expect(bundle.tarball.readUInt32LE(4)).toBe(0); // gzip's time
    expect(bundle.tarball[9]).toBe(0xff); // gzip's system: unknown
    for (const e of entries) {
      expect(e.mtime, e.name).toBe(315532800);
      expect([e.uid, e.gid], e.name).toEqual([0, 0]);
    }
    const names = entries.map((e) => e.name);
    expect(names).toEqual(names.toSorted((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
  });

  it("keeps everything below one top folder, the executables executable", () => {
    for (const e of entries) expect(e.name === `${top}/` || e.name.startsWith(`${top}/`), e.name).toBe(true);
    for (const platform of PLATFORMS) expect(file(`bin/${executableName(platform)}`)?.mode).toBe(0o755);
    expect(file("bin/install.sh")?.mode).toBe(0o755);
    expect(file("README.md")?.mode).toBe(0o644);
    expect(entries.filter((e) => e.type === "5").every((e) => e.mode === 0o755)).toBe(true);
  });

  it("has a manifest that validates against contracts/offline-bundle-manifest.schema.json", () => {
    expect(validate(bundle.manifest), JSON.stringify(validate.errors)).toBe(true);
    expect(file("manifest.json")?.content.toString("utf8")).toBe(bundle.manifestText);
    expect(JSON.parse(bundle.manifestText)).toEqual(bundle.manifest);
    expect(bundle.manifest).toMatchObject({ format: 1, name: "cavelon-bundle", version: VERSION, repository: "goodguys-gmbh/cavelon-dev-kit" });
  });

  it("names the instance contract versions the kit's own check accepts", () => {
    expect(bundle.manifest.instance_contracts).toEqual({
      api_versions: [...SUPPORTED_CONTRACTS.api_versions],
      package_versions: [...SUPPORTED_CONTRACTS.package_versions],
    });
  });

  it("lists every file it carries with its size and SHA-256, and nothing else", () => {
    const carried = entries.filter((e) => e.type === "0" && e.name !== `${top}/manifest.json`);
    const listed = bundle.manifest.files;
    expect(listed.map((f) => f.path)).toEqual(carried.map((e) => e.name.slice(top.length + 1)));
    for (const f of listed) {
      const e = file(f.path)!;
      expect(f.size, f.path).toBe(e.content.length);
      expect(f.sha256, f.path).toBe(sha256(e.content));
    }
  });

  it("carries the executables, the plugin, the skills, the marketplaces and the plugin packages", () => {
    const paths = bundle.manifest.files.map((f) => f.path);
    expect(bundle.manifest.executables.map((e) => e.platform)).toEqual(PLATFORMS);
    for (const skill of ["cavelon-loop", "cavelon-authoring", "cavelon-testing", "cavelon-long-running"]) {
      expect(paths).toContain(`skills/${skill}/SKILL.md`);
      expect(paths).toContain(`plugin/skills/${skill}/SKILL.md`);
      expect(file(`skills/${skill}/SKILL.md`)?.content.equals(readFileSync(path.join(ROOT, "plugin", "skills", skill, "SKILL.md")))).toBe(true);
    }
    for (const p of ["plugin/.claude-plugin/plugin.json", "plugin/.codex-plugin/plugin.json", ".claude-plugin/marketplace.json", ".agents/plugins/marketplace.json", "LICENSE", "README.md"]) {
      expect(paths).toContain(p);
    }
    expect(paths.filter((p) => p.startsWith("plugin-packages/"))).toEqual([
      "plugin-packages/cavelon-agent-plugin-windows.tar.gz",
      "plugin-packages/cavelon-agent-plugin.tar.gz",
      "plugin-packages/cavelon-marketplace.tar.gz",
      "plugin-packages/darwin.cavelon-gemini-extension.tar.gz",
      "plugin-packages/linux.cavelon-gemini-extension.tar.gz",
      "plugin-packages/win32.cavelon-gemini-extension.tar.gz",
    ]);
    const sums = file("bin/checksums.txt")!.content.toString("utf8");
    for (const name of [...PLATFORMS.map(executableName), "install.sh", "install.ps1"]) {
      expect(sums).toContain(`${sha256(file(`bin/${name}`)!.content)}  ${name}\n`);
    }
  });

  it("starts the cavelon on the PATH from its MCP entries, never npx, and checks for no update", () => {
    const plugin = JSON.parse(file("plugin/.mcp.json")!.content.toString("utf8"));
    expect(plugin).toEqual({ mcpServers: { cavelon: { command: "cavelon", args: ["mcp"], env: { CAVELON_PLUGIN_VERSION: VERSION, CAVELON_NO_UPDATE_CHECK: "1" } } } });
    const entry = JSON.parse(file("mcp/cavelon.mcp.json")!.content.toString("utf8"));
    expect(entry).toEqual({ mcpServers: { cavelon: { command: "cavelon", args: ["mcp"], env: { CAVELON_NO_UPDATE_CHECK: "1" } } } });
    expect(bundle.manifest.mcp).toEqual({ plugin: "plugin/.mcp.json", entry: "mcp/cavelon.mcp.json" });
  });

  // The release's own packages fall back to npx, which has no registry offline.
  it("carries the plugin packages that start the cavelon on the PATH, as render.mjs --server installed writes them", () => {
    const rendered = path.join(temp, "rendered");
    const run = spawnSync(process.execPath, ["packaging/render.mjs", "plugins", "--server", "installed", "--out", rendered], { cwd: ROOT, encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    const installed = { command: "cavelon", args: ["mcp"], env: { CAVELON_PLUGIN_VERSION: VERSION } };
    for (const name of ["cavelon-agent-plugin.tar.gz", "cavelon-agent-plugin-windows.tar.gz", "linux.cavelon-gemini-extension.tar.gz", "win32.cavelon-gemini-extension.tar.gz", "cavelon-marketplace.tar.gz"]) {
      const carried = file(`plugin-packages/${name}`)!.content;
      expect(carried.equals(readFileSync(path.join(rendered, name))), name).toBe(true);
      const inner = readTar(carried);
      const read = (n: string) => JSON.parse(inner.find((e) => e.name === n)!.content.toString("utf8"));
      if (name.startsWith("cavelon-agent-plugin")) expect(read("mcp.json").mcpServers.cavelon, name).toMatchObject({ type: "stdio", ...installed });
      else if (name.includes("gemini")) expect(read("gemini-extension.json").mcpServers.cavelon, name).toEqual(installed);
      else expect(read("plugin/.mcp.json").mcpServers.cavelon, name).toEqual(installed);
      for (const e of inner.filter((x) => x.name.endsWith(".json"))) expect(e.content.toString("utf8"), `${name}: ${e.name}`).not.toMatch(/\bnpx\b/);
    }
  });

  it("refuses a missing platform unless told, and a name it cannot carry", () => {
    const some = executables("some", ["linux-x64"]);
    expect(() => buildBundle({ ...options, executablesDir: some })).toThrow(/cavelon-darwin-arm64 is missing/);
    expect(buildBundle({ ...options, executablesDir: some, allowMissingExecutables: true }).manifest.executables).toEqual([
      { platform: "linux-x64", path: "bin/cavelon-linux-x64" },
    ]);
    const odd = sourceTree("odd");
    writeFileSync(path.join(odd, "plugin", "skills", "a name with spaces.md"), "x");
    expect(() => buildBundle({ ...options, root: odd })).toThrow(/is not a name the bundle takes/);
    expect(() => buildBundle({ ...options, version: "1.2" })).toThrow(/not a release version/);
  });

  it.skipIf(process.platform === "win32")("refuses a symbolic link in the plugin", () => {
    const linked = sourceTree("linked");
    symlinkSync("/etc/hostname", path.join(linked, "plugin", "skills", "link.md"));
    expect(() => buildBundle({ ...options, root: linked })).toThrow(/symbolic link/);
  });

  it("has a schema that refuses a path out of the bundle and an unknown platform", () => {
    const broken = (change: (m: BundleManifest) => void) => {
      const copy = structuredClone(bundle.manifest);
      change(copy);
      return validate(copy);
    };
    expect(broken((m) => (m.files[0]!.path = "../escape"))).toBe(false);
    expect(broken((m) => (m.files[0]!.path = "/etc/passwd"))).toBe(false);
    expect(broken((m) => (m.files[0]!.sha256 = "ABC"))).toBe(false);
    expect(broken((m) => (m.executables[0]!.platform = "plan9-x64"))).toBe(false);
    expect(broken((m) => (m.instance_contracts.api_versions = []))).toBe(false);
  });

  // install.sh reads checksums.txt and the executable from the bundle's bin
  // folder; nothing is downloaded.
  it.skipIf(process.platform === "win32")("installs from the extracted bundle with install.sh", () => {
    const out = path.join(temp, "extracted");
    mkdirSync(out, { recursive: true });
    const tarball = path.join(temp, `${top}.tar.gz`);
    writeFileSync(tarball, bundle.tarball);
    const untar = spawnSync("tar", ["-xzf", tarball, "-C", out], { encoding: "utf8" });
    expect(untar.status, untar.stderr).toBe(0);
    const home = path.join(temp, "home");
    mkdirSync(home, { recursive: true });
    const dir = path.join(temp, "installed");
    const bin = path.join(out, top, "bin");
    const run = spawnSync("sh", [path.join(bin, "install.sh"), "--dir", dir, "--no-modify-path"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: home, CAVELON_DOWNLOAD_URL: bin, http_proxy: "http://127.0.0.1:9", https_proxy: "http://127.0.0.1:9" },
    });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain(`Installed cavelon ${VERSION}`);
    expect(existsSync(path.join(dir, "cavelon"))).toBe(true);

    // A changed executable is refused, as from a download.
    writeFileSync(path.join(bin, executableName(`${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`)), "#!/bin/sh\necho tampered\n");
    const tampered = spawnSync("sh", [path.join(bin, "install.sh"), "--dir", dir, "--no-modify-path"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: home, CAVELON_DOWNLOAD_URL: bin },
    });
    expect(tampered.status).not.toBe(0);
    expect(tampered.stderr).toContain("does not match checksums.txt");
  });
});
