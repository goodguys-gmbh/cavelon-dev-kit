// Build the offline bundle of a release: cavelon-bundle-<version>.tar.gz, for
// machines that reach neither GitHub, npm nor PyPI. docs/offline-bundle.md
// describes its format; contracts/offline-bundle-manifest.schema.json is the
// schema of its manifest.json. Run it from the repository's root after
// `npm run build` in cli/ (the supported contract versions come from
// cli/dist/version.js):
//
//   node packaging/bundle/build-bundle.mjs --executables release [--commit <sha>] [--allow-missing-executables]
//
// --executables is a folder holding the release's standalone executables
// (cavelon-<os>-<arch>[.exe]); every platform must be there unless
// --allow-missing-executables is given, for a trial build on one machine.
// The plugin packages for the other clients are rendered here, in the variant
// `node packaging/render.mjs plugins --server installed` writes: the release's
// own packages fall back to npx, which cannot reach the registry offline.
//
// It writes packaging-out/bundle/cavelon-bundle-<version>.tar.gz and, beside
// it, a copy of the manifest (cavelon-bundle-<version>.manifest.json) that the
// release signs. The folder is fixed, as render.mjs's is: a script that writes
// only there cannot be pointed at another file.
// The same inputs give the same bytes: the entries are sorted, carry one fixed
// time and no owner, and the gzip header holds no time or system.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { constants, gzipSync } from "node:zlib";
import { renderPlugins } from "../plugins.mjs";

export const REPOSITORY = "goodguys-gmbh/cavelon-dev-kit";
export const BUNDLE_FORMAT = 1;
export const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "windows-x64"];

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = path.join(ROOT, "packaging-out", "bundle");
const BLOCK = 512;
// 1980-01-01T00:00:00Z: a fixed time that no archive tool calls implausibly old.
const MTIME = 315532800;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

export const executableName = (platform) => `cavelon-${platform}${platform.startsWith("windows-") ? ".exe" : ""}`;

/**
 * The offline MCP entry: the `cavelon` on the PATH, never npx, which cannot
 * reach the registry offline. No update check either: it would only wait for
 * GitHub. `plugin` adds the plugin's version, as plugin/.mcp.json does.
 */
export function offlineMcpEntry(pluginVersion) {
  const env = { ...(pluginVersion ? { CAVELON_PLUGIN_VERSION: pluginVersion } : {}), CAVELON_NO_UPDATE_CHECK: "1" };
  return { mcpServers: { cavelon: { command: "cavelon", args: ["mcp"], env } } };
}

const jsonText = (value) => `${JSON.stringify(value, null, 2)}\n`;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** A file or folder name that may go into the bundle: no separators, controls or leading dot. */
function checkedName(name, where) {
  if (!NAME.test(name)) throw new Error(`${where}: "${name}" is not a name the bundle takes (letters, digits, ".", "_", "+" and "-", not first a dot).`);
  return name;
}

/** Every regular file below `dir`, as [relative parts, absolute path], sorted; symbolic links are refused. */
function filesBelow(dir, where, parts = []) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).toSorted((a, b) => byBytes(a.name, b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`${where}: ${full} is a symbolic link; the bundle takes regular files only.`);
    // A plugin's own folders (.claude-plugin, .codex-plugin) and .mcp.json start with a dot.
    const name = entry.name.startsWith(".") ? `.${checkedName(entry.name.slice(1), where)}` : checkedName(entry.name, where);
    if (entry.isDirectory()) found.push(...filesBelow(full, where, [...parts, name]));
    else if (entry.isFile()) found.push([[...parts, name], full]);
    else throw new Error(`${where}: ${full} is neither a file nor a folder.`);
  }
  return found;
}

/** The bundle's files: path inside the bundle → { bytes, mode }. */
class FileSet {
  files = new Map();

  add(relative, bytes, mode = 0o644) {
    if (this.files.has(relative)) throw new Error(`${relative} would go into the bundle twice.`);
    this.files.set(relative, { bytes: Buffer.from(bytes), mode });
  }

  /** Every file below `dir`, under `prefix`, except the paths in `skip`. */
  addTree(dir, prefix, where, skip = []) {
    for (const [parts, full] of filesBelow(dir, where)) {
      const relative = parts.join("/");
      if (!skip.includes(relative)) this.add(`${prefix}/${relative}`, readFileSync(full));
    }
  }
}

function checkOptions({ version, contracts, commit }) {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version ?? "")) throw new Error(`"${version}" is not a release version.`);
  if (!Array.isArray(contracts?.api_versions) || !Array.isArray(contracts?.package_versions)) {
    throw new TypeError("The supported contract versions (api_versions, package_versions) are missing.");
  }
  if (commit !== undefined && !/^[0-9a-f]{40}$/.test(commit)) throw new Error(`"${commit}" is not a full commit id.`);
}

/**
 * The standalone executables, with a checksums.txt that install.sh and
 * install.ps1 read when CAVELON_DOWNLOAD_URL names this folder.
 */
function addExecutables(set, root, executablesDir, allowMissing) {
  const executables = [];
  for (const platform of PLATFORMS) {
    const name = executableName(platform);
    const file = path.join(executablesDir, name);
    if (existsSync(file)) {
      if (!lstatSync(file).isFile()) throw new Error(`${file} is not a regular file.`);
      set.add(`bin/${name}`, readFileSync(file), 0o755);
      executables.push({ platform, path: `bin/${name}` });
    } else if (!allowMissing) {
      throw new Error(`${file} is missing; the bundle carries every platform's executable (--allow-missing-executables for a trial).`);
    }
  }
  if (!executables.length) throw new Error(`${executablesDir} holds no cavelon executable.`);
  set.add("bin/install.sh", readFileSync(path.join(root, "install.sh")), 0o755);
  set.add("bin/install.ps1", readFileSync(path.join(root, "install.ps1")));
  const sums = [...set.files].filter(([p]) => p.startsWith("bin/")).map(([p, f]) => `${sha256(f.bytes)}  ${p.slice("bin/".length)}\n`);
  set.add("bin/checksums.txt", sums.join(""));
  return executables;
}

/**
 * The plugin for Claude Code and Codex with the offline MCP entry, the
 * marketplaces that name it (so the bundle's folder is a local marketplace),
 * and the skills and MCP entry on their own, for agents without a plugin.
 */
function addPlugin(set, root, version) {
  const pluginVersion = JSON.parse(readFileSync(path.join(root, "plugin", ".claude-plugin", "plugin.json"), "utf8")).version;
  if (pluginVersion !== version) throw new Error(`The plugin's version ${pluginVersion} is not the release's ${version}.`);
  set.addTree(path.join(root, "plugin"), "plugin", "plugin", [".mcp.json"]);
  set.add("plugin/.mcp.json", jsonText(offlineMcpEntry(pluginVersion)));
  set.add(".claude-plugin/marketplace.json", readFileSync(path.join(root, ".claude-plugin", "marketplace.json")));
  set.add(".agents/plugins/marketplace.json", readFileSync(path.join(root, ".agents", "plugins", "marketplace.json")));
  set.addTree(path.join(root, "plugin", "skills"), "skills", "skills");
  set.add("mcp/cavelon.mcp.json", jsonText(offlineMcpEntry()));
}

/**
 * The plugin packages for the other clients, with the MCP entry `cavelon mcp`
 * and the release's file names. renderPlugins also writes each package
 * unpacked; only the archives go into the bundle.
 */
function addPluginPackages(set, root, version) {
  const out = mkdtempSync(path.join(os.tmpdir(), "cavelon-bundle-plugins-"));
  try {
    for (const file of renderPlugins({ root, version, server: "installed", out }).toSorted(byBytes)) {
      set.add(`plugin-packages/${checkedName(path.basename(file), "plugin packages")}`, readFileSync(file));
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/**
 * Build the bundle in memory: { name, tarball, manifest, manifestText }.
 * `contracts` is the kit's SUPPORTED_CONTRACTS; `executablesDir` holds
 * cavelon-<platform>[.exe].
 */
export function buildBundle({ root = ROOT, version, contracts, executablesDir, commit, allowMissingExecutables = false }) {
  checkOptions({ version, contracts, commit });
  const set = new FileSet();
  const executables = addExecutables(set, root, executablesDir, allowMissingExecutables);
  addPlugin(set, root, version);
  addPluginPackages(set, root, version);
  set.add("README.md", readFileSync(path.join(root, "packaging", "bundle", "README.md")));
  set.add("LICENSE", readFileSync(path.join(root, "LICENSE")));
  const files = set.files;

  const manifest = {
    format: BUNDLE_FORMAT,
    name: "cavelon-bundle",
    version,
    repository: REPOSITORY,
    ...(commit ? { commit } : {}),
    instance_contracts: { api_versions: [...contracts.api_versions], package_versions: [...contracts.package_versions] },
    executables,
    mcp: { plugin: "plugin/.mcp.json", entry: "mcp/cavelon.mcp.json" },
    files: [...files.keys()].toSorted(byBytes).map((p) => ({ path: p, size: files.get(p).bytes.length, sha256: sha256(files.get(p).bytes) })),
  };
  const manifestText = jsonText(manifest);
  set.add("manifest.json", manifestText);

  const top = `cavelon-bundle-${version}`;
  return { name: top, tarball: gzip(tar(top, files)), manifest, manifestText };
}

function byBytes(a, b) {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return Buffer.compare(x, y);
}

// --- a deterministic USTAR archive ---------------------------------------------

function octal(value, width) {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function header(name, prefix, size, mode, type) {
  const block = Buffer.alloc(BLOCK);
  block.write(name, 0, 100, "utf8");
  block.write(octal(mode, 8), 100, "ascii");
  block.write(octal(0, 8), 108, "ascii");
  block.write(octal(0, 8), 116, "ascii");
  block.write(octal(size, 12), 124, "ascii");
  block.write(octal(MTIME, 12), 136, "ascii");
  block.write("        ", 148, "ascii");
  block.write(type, 156, "ascii");
  block.write("ustar\0", 257, "ascii");
  block.write("00", 263, "ascii");
  block.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return block;
}

function padded(bytes) {
  const rest = bytes.length % BLOCK;
  return rest ? [bytes, Buffer.alloc(BLOCK - rest)] : [bytes];
}

/** USTAR's name and prefix fields, or undefined when the name needs a PAX record. */
function ustarFields(name) {
  if (!/^[\x20-\x7e]+$/.test(name)) return undefined;
  if (name.length <= 100) return { name, prefix: "" };
  for (let at = name.indexOf("/"); at !== -1; at = name.indexOf("/", at + 1)) {
    if (at <= 155 && name.length - at - 1 <= 100) return { name: name.slice(at + 1), prefix: name.slice(0, at) };
  }
  return undefined;
}

function paxRecord(key, value) {
  // The record's length counts its own digits.
  const body = ` ${key}=${value}\n`;
  const size = Buffer.byteLength(body, "utf8");
  let total = size + 1;
  while (size + String(total).length !== total) total = size + String(total).length;
  return Buffer.from(`${total}${body}`, "utf8");
}

function entry(name, bytes, mode, type) {
  const fields = ustarFields(name);
  if (fields) return [header(fields.name, fields.prefix, bytes.length, mode, type), ...padded(bytes)];
  const pax = paxRecord("path", name);
  return [header("PaxHeader", "", pax.length, 0o644, "x"), ...padded(pax), header(name.slice(0, 99), "", bytes.length, mode, type), ...padded(bytes)];
}

function tar(top, files) {
  const directories = new Set([top]);
  for (const relative of files.keys()) {
    const parts = relative.split("/");
    for (let i = 1; i < parts.length; i++) directories.add(`${top}/${parts.slice(0, i).join("/")}`);
  }
  const entries = [
    ...[...directories].map((d) => ({ name: `${d}/`, bytes: Buffer.alloc(0), mode: 0o755, type: "5" })),
    ...[...files].map(([p, f]) => ({ name: `${top}/${p}`, bytes: f.bytes, mode: f.mode, type: "0" })),
  ].toSorted((a, b) => byBytes(a.name, b.name));
  const blocks = entries.flatMap((e) => entry(e.name, e.bytes, e.mode, e.type));
  return Buffer.concat([...blocks, Buffer.alloc(BLOCK * 2)]);
}

function gzip(bytes) {
  const out = gzipSync(bytes, { level: constants.Z_BEST_COMPRESSION });
  // The header's time is already 0; its system byte depends on where zlib was
  // built, so it is set to "unknown" for the same bytes on every system.
  out[9] = 0xff;
  return out;
}

// --- the command ------------------------------------------------------------------

async function main() {
  const { values } = parseArgs({
    options: {
      executables: { type: "string" },
      commit: { type: "string" },
      "allow-missing-executables": { type: "boolean", default: false },
    },
  });
  if (!values.executables) {
    throw new Error("Usage, from the repository's root: node packaging/bundle/build-bundle.mjs --executables <dir> [--commit <sha>] [--allow-missing-executables]");
  }
  const versionModule = path.join(ROOT, "cli", "dist", "version.js");
  if (!existsSync(versionModule)) throw new Error("Run `npm run build` in cli/ first: cli/dist/version.js is missing.");
  const { KIT_VERSION, SUPPORTED_CONTRACTS } = await import(pathToFileURL(versionModule).href);
  const version = JSON.parse(readFileSync(path.join(ROOT, "cli", "package.json"), "utf8")).version;
  if (KIT_VERSION !== version) throw new Error(`cli/dist is version ${KIT_VERSION}, cli/package.json ${version}; run \`npm run build\` again.`);

  const bundle = buildBundle({
    version,
    contracts: SUPPORTED_CONTRACTS,
    executablesDir: path.resolve(values.executables),
    commit: values.commit,
    allowMissingExecutables: values["allow-missing-executables"],
  });
  mkdirSync(OUT, { recursive: true });
  const tarball = path.join(OUT, `${bundle.name}.tar.gz`);
  const manifest = path.join(OUT, `${bundle.name}.manifest.json`);
  writeFileSync(tarball, bundle.tarball);
  writeFileSync(manifest, bundle.manifestText);
  process.stdout.write(`${tarball}\n${manifest}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
