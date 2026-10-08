import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { bundledNativeAssets } from "./native-assets.js";
import { readTextFile, writeFileAtomic } from "./fsutil.js";
import { appendJsoncMember, readJsoncEntry, removeJsoncEntry, removeJsoncMember, upsertJsoncEntry } from "./jsonc-config.js";
import { decodeMcpEntry, encodeMcpEntry, isKitMcpEntry, type McpCommand } from "./mcp-entry.js";
import { nativeClient, hasNativeApprovalAdapter, readNativeMcp, resolveNativeMcp, type NativeMcpConfig } from "./native-clients.js";
import { nativeEntryHash, type NativeProfile } from "./native-approval/profile.js";
import { KIT_VERSION } from "./version.js";

type Env = Record<string, string | undefined>;
type Client = "opencode" | "pi";
interface Reference { file: string; key: "plugin" | "extensions"; member: string; created: boolean; kept: boolean }
interface Installation {
  format: 1; client: Client; scope: "user" | "project"; version: string; projectRoot?: string;
  files: Record<string, string>;
  mcp: { file: string; hash: string; created: boolean; kept: number };
  references: Reference[];
}
interface Write { file: string; before: string | undefined; after: string | undefined; mode: number }
export interface NativeInstallPlan {
  directory: string; outcome: "planned" | "unchanged" | "skipped"; reason?: string;
  writes: Write[];
}
export type NativeWriter = (file: string, content: string, mode: number, dirMode: number) => Promise<void>;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const portable = (base: string, file: string) => path.relative(base, file).split(path.sep).join("/") || ".";
const memberPath = (file: string, target: string) => "./" + portable(path.dirname(file), target);
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
const inside = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

async function safeFile(file: string, root?: string): Promise<void> {
  const stat = await fs.lstat(file).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
  if (stat?.isSymbolicLink() || (stat && !stat.isFile())) throw new Error(`Native installation will not replace a symlink or non-file: ${file}`);
  if (root) {
    let parent = path.dirname(file);
    while (!await fs.stat(parent).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; })) parent = path.dirname(parent);
    const canonical = path.join(await fs.realpath(parent), path.relative(parent, file));
    if (!inside(await fs.realpath(root), canonical)) throw new Error("Native installation cannot write outside its project.");
  }
}

async function readInstallation(directory: string): Promise<Installation | undefined> {
  const stat = await fs.lstat(directory).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
  if (!stat) return undefined;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("The native directory is not an owned regular directory.");
  const file = path.join(directory, "installation.json");
  await safeFile(file);
  const text = await readTextFile(file);
  if (!text) throw new Error("The native directory belongs to a personal integration; no Cavelon ownership record exists.");
  let record: Installation;
  try { record = JSON.parse(text) as Installation; }
  catch { throw new Error("Invalid native ownership record; inspect the installation before repeating setup."); }
  if (record.format !== 1 || !["opencode", "pi"].includes(record.client) || !["user", "project"].includes(record.scope)
    || typeof record.version !== "string" || !record.files || typeof record.files !== "object" || Array.isArray(record.files)
    || !record.mcp || typeof record.mcp.file !== "string" || !/^[a-f0-9]{64}$/.test(record.mcp.hash)
    || typeof record.mcp.created !== "boolean" || !Number.isInteger(record.mcp.kept) || record.mcp.kept < 0 || record.mcp.kept > 1
    || !Array.isArray(record.references) || !record.references.length
    || record.references.some(ref => !ref || typeof ref.file !== "string" || !["plugin", "extensions"].includes(ref.key) || typeof ref.member !== "string"
      || typeof ref.created !== "boolean" || typeof ref.kept !== "boolean")
    || (record.scope === "project" && record.projectRoot !== "../..")) {
    throw new Error("Invalid native ownership record; inspect the installation before repeating setup.");
  }
  for (const [name, digest] of Object.entries(record.files)) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(name) || name === "installation.json" || !/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid native asset ownership.");
  }
  return record;
}

const fileOf = (directory: string, file: string) => path.resolve(directory, file);
async function referenceCount(file: string, value: unknown[], member: string): Promise<number> {
  const target = path.resolve(path.dirname(file), member);
  const canonical = await fs.realpath(target).catch(() => target);
  let count = 0;
  for (const item of value) {
    const spec = Array.isArray(item) ? item[0] : item;
    if (typeof spec !== "string") continue;
    let full: string;
    try {
      if (spec.startsWith("file:")) full = fileURLToPath(spec);
      else if (path.isAbsolute(spec) || spec.startsWith("./") || spec.startsWith("../")) full = path.resolve(path.dirname(file), spec);
      else continue;
    } catch { continue; }
    if (await fs.realpath(full).catch(() => full) === canonical) count++;
  }
  return count;
}
async function verify(directory: string, record: Installation): Promise<void> {
  const root = record.scope === "project" ? fileOf(directory, record.projectRoot!) : undefined;
  for (const [name, digest] of Object.entries(record.files)) {
    const file = path.join(directory, name);
    await safeFile(file, root);
    const text = await readTextFile(file);
    if (text === undefined || hash(text) !== digest) throw new Error(`Native asset ${name} was edited or removed; personal changes are preserved.`);
  }
  const mcpFile = fileOf(directory, record.mcp.file);
  await safeFile(mcpFile, root);
  const mcp = nativeClient(record.client)!.project()!;
  const selected = readNativeMcp(await readTextFile(mcpFile), mcp);
  if ("error" in selected || selected.value === undefined || nativeEntryHash(selected.value) !== record.mcp.hash) throw new Error("The native Cavelon MCP entry was edited; review it before update or removal.");
  for (const ref of record.references) {
    const file = fileOf(directory, ref.file);
    await safeFile(file, root);
    const entry = readJsoncEntry(await readTextFile(file), [ref.key]);
    if ("error" in entry || !Array.isArray(entry.value) || entry.value.filter(member => isDeepStrictEqual(member, ref.member)).length !== 1
      || await referenceCount(file, entry.value, ref.member) !== 1) {
      throw new Error("A native plugin reference was edited or duplicated; personal settings are preserved.");
    }
  }
}

async function chooseFile(files: string[], fallback: string): Promise<string> {
  const present = [];
  for (const file of files) if (await readTextFile(file) !== undefined) present.push(file);
  return present.at(-1) ?? fallback;
}

/** OpenCode's TUI has its own config precedence, separate from OPENCODE_CONFIG. */
async function references(client: Client, directory: string, mcpFile: string, env: Env, root?: string): Promise<Array<{ file: string; key: Reference["key"]; member: string }>> {
  if (client === "pi") return [{ file: path.join(path.dirname(directory), "settings.json"), key: "extensions", member: memberPath(path.join(path.dirname(directory), "settings.json"), path.join(directory, "pi-extension.mjs")) }];
  const global = path.dirname(nativeClient(client)!.user({ ...env, OPENCODE_CONFIG_DIR: undefined }).skills);
  const configDir = env.OPENCODE_CONFIG_DIR;
  const files = root ? [path.join(root, "tui.json"), path.join(root, "tui.jsonc"), path.join(root, ".opencode", "tui.json"), path.join(root, ".opencode", "tui.jsonc")] :
    [path.join(global, "tui.json"), path.join(global, "tui.jsonc"), ...(env.OPENCODE_TUI_CONFIG ? [env.OPENCODE_TUI_CONFIG] : []),
      ...(configDir ? [path.join(configDir, "tui.json"), path.join(configDir, "tui.jsonc")] : [])];
  if (root && env.OPENCODE_TUI_CONFIG) throw new Error("OPENCODE_TUI_CONFIG overrides project UI settings; use user setup for that configuration.");
  const fallback = !root && configDir ? path.join(configDir, "tui.json") : !root && env.OPENCODE_TUI_CONFIG ? env.OPENCODE_TUI_CONFIG : path.join(root ?? global, "tui.json");
  const tuiFile = await chooseFile(files, fallback);
  return [
    { file: mcpFile, key: "plugin", member: memberPath(mcpFile, path.join(directory, "opencode-server-entry.mjs")) },
    { file: tuiFile, key: "plugin", member: memberPath(tuiFile, path.join(directory, "opencode-tui-entry.mjs")) },
  ];
}

/** Build all edits before any write; the output stays internal, never in CLI JSON. */
export async function planNativeInstallation(config: NativeMcpConfig, command: McpCommand, env: Env, options: { root?: string; directory?: string; mcpRecord?: { file: string; created: boolean; kept?: number } } = {}): Promise<NativeInstallPlan> {
  if (!hasNativeApprovalAdapter(config)) throw new Error("This client has no native person-dialog adapter.");
  const root = options.root;
  const expectedDirectory = root ? path.join(root, config.client === "pi" ? ".pi" : ".opencode", "cavelon") : path.join(path.dirname(nativeClient(config.client)!.user(env).skills), "cavelon");
  const directory = options.directory ?? expectedDirectory;
  const skipped = (reason: string): NativeInstallPlan => ({ directory, outcome: "skipped", reason, writes: [] });
  try {
    if (path.resolve(directory) !== path.resolve(expectedDirectory)) return skipped("Native config directories changed; remove the recorded integration before setting up the new location.");
    const previous = await readInstallation(directory);
    if (previous) {
      if (previous.client !== config.client || previous.scope !== (root ? "project" : "user")) return skipped("The native directory is owned by another integration.");
      await verify(directory, previous);
    }
    let effective = config;
    let user: Installation | undefined;
    if (root) {
      const userDirectory = path.join(path.dirname(nativeClient(config.client)!.user(env).skills), "cavelon");
      user = await readInstallation(userDirectory);
      if (user) {
        if (user.client !== config.client || user.scope !== "user") return skipped("The user native directory belongs to another integration.");
        await verify(userDirectory, user);
        const userFile = fileOf(userDirectory, user.mcp.file);
        effective = { ...config, shadowFiles: config.shadowFiles?.filter(file => path.resolve(file) !== userFile) };
      }
    }
    const selected = await resolveNativeMcp(effective, root);
    if ("error" in selected) return skipped(selected.error);
    if (root && user && selected.current === undefined && !previous) return { directory, outcome: "unchanged", reason: "The verified user native integration already serves this project; no duplicate project integration was added.", writes: [] };
    if (previous && fileOf(directory, previous.mcp.file) !== selected.file) return skipped("The selected MCP config changed; remove the recorded integration first.");
    if (selected.current !== undefined && !(previous && nativeEntryHash(selected.current) === previous.mcp.hash)
      && !isKitMcpEntry(selected.current, config.entryFormat, config.extra)) return skipped("A personal Cavelon server already exists; it is not owned by native setup.");
    const disabled = encodeMcpEntry(command, config.entryFormat, { ...config.extra, enabled: false });
    const assets = await bundledNativeAssets();
    const profile: NativeProfile = { ...(root ? { format: 2 as const, projectRoot: portable(directory, root) } : {}),
      client: config.client, version: KIT_VERSION, scope: root ? "project" : "user", configFile: root ? portable(directory, selected.file) : selected.file, entryHash: nativeEntryHash(disabled) };
    const contents = new Map(assets.map(asset => [asset.path, asset.content]));
    contents.set("profile.json", json(profile));
    if (config.client === "opencode") for (const surface of ["server", "tui"]) {
      contents.set(`opencode-${surface}-entry.mjs`, `import adapter from "./opencode-${surface}.mjs";\nexport default { ...adapter, id: "cavelon.native-approval.${root ? "project" : "user"}" };\n`);
    }
    const writes = new Map<string, Write>();
    const replace = async (file: string, after: string | undefined) => {
      await safeFile(file, root);
      const before = await readTextFile(file);
      writes.set(file, { file, before, after, mode: await fs.stat(file).then(stat => stat.mode & 0o777, () => 0o600) });
    };
    for (const [name, content] of contents) {
      if (previous && !(name in previous.files) && await readTextFile(path.join(directory, name)) !== undefined) return skipped(`The new native asset ${name} belongs to a personal file; it is preserved.`);
      await replace(path.join(directory, name), content);
    }
    const refs: Reference[] = [];
    for (const ref of await references(config.client, directory, selected.file, env, root)) {
      const before = writes.get(ref.file)?.after ?? await readTextFile(ref.file);
      if (config.client === "pi" && before !== undefined) {
        try { JSON.parse(before); }
        catch { return skipped("Pi settings require plain JSON; correct the file before native installation."); }
      }
      for (const id of ["cavelon.native-approval", `cavelon.native-approval.${root ? "project" : "user"}`]) {
        const enabled = readJsoncEntry(before, ["plugin_enabled", id]);
        if ("error" in enabled) return skipped(enabled.error);
        if (enabled.value === false) return skipped("The person turned off the Cavelon plugin; setup does not enable it.");
      }
      const current = readJsoncEntry(before, [ref.key]);
      if ("error" in current) return skipped(current.error);
      if (Array.isArray(current.value)) {
        const aliases = await referenceCount(ref.file, current.value, ref.member);
        if (aliases > 1 || (aliases === 1 && !current.value.includes(ref.member))) return skipped("An aliased or duplicate Cavelon plugin reference exists; review it manually.");
      }
      const added = appendJsoncMember(before, [ref.key], ref.member);
      if (added.outcome === "skipped") return skipped(added.reason!);
      if (!previous && added.outcome === "unchanged") return skipped("An existing native plugin reference is not owned by setup; review it manually.");
      await replace(ref.file, added.content ?? before);
      const old = previous?.references.find(item => fileOf(directory, item.file) === ref.file && item.key === ref.key && item.member === ref.member);
      refs.push({ file: root ? portable(directory, ref.file) : ref.file, key: ref.key, member: ref.member, created: old?.created ?? before === undefined, kept: old?.kept ?? current.value !== undefined });
    }
    if (previous && previous.references.some(old => !refs.some(ref => isDeepStrictEqual(ref, old)))) return skipped("Native reference locations changed; remove the recorded integration first.");
    const before = writes.get(selected.file)?.after ?? selected.text;
    const entry = upsertJsoncEntry(before, config.keys, disabled, { matches: value => isKitMcpEntry(value, config.entryFormat, config.extra)
      || Boolean(previous && nativeEntryHash(value) === previous.mcp.hash) });
    if (entry.outcome === "skipped") return skipped(entry.reason!);
    await replace(selected.file, entry.content ?? before);
    const record: Installation = { format: 1, client: config.client, scope: root ? "project" : "user", version: KIT_VERSION,
      ...(root ? { projectRoot: portable(directory, root) } : {}), files: Object.fromEntries([...contents].map(([name, content]) => [name, hash(content)])),
      mcp: { file: root ? portable(directory, selected.file) : selected.file, hash: nativeEntryHash(disabled), created: previous?.mcp.created ?? (options.mcpRecord?.file === selected.file ? options.mcpRecord.created : selected.text === undefined), kept: previous?.mcp.kept ?? options.mcpRecord?.kept ?? selected.kept }, references: refs };
    await replace(path.join(directory, "installation.json"), json(record));
    const changed = [...writes.values()].filter(write => write.before !== write.after);
    return { directory, outcome: changed.length ? "planned" : "unchanged", writes: changed };
  } catch (error) { return skipped(error instanceof Error ? error.message : String(error)); }
}

/** Refuse concurrent edits; rollback only bytes this transaction actually wrote. */
export async function applyNativeInstallation(plan: NativeInstallPlan, writer: NativeWriter = writeFileAtomic): Promise<void> {
  if (plan.outcome !== "planned") return;
  // Two installers must not roll back identical bytes written by each other.
  await fs.mkdir(path.dirname(plan.directory), { recursive: true, mode: 0o700 });
  const lockFile = plan.directory + ".lock";
  const lock = await fs.open(lockFile, "wx", 0o600).catch(error => {
    if (error.code === "EEXIST") throw new Error("Another native installer holds this directory's lock; inspect it before retrying.");
    throw error;
  });
  const lockIdentity = await lock.stat();
  const done: Write[] = [];
  try {
    await lock.writeFile(`cavelon-native ${process.pid}\n`);
    for (const write of plan.writes) {
      await safeFile(write.file);
      if (await readTextFile(write.file) !== write.before) throw new Error("Native configuration changed after planning; no further edits were made.");
      done.push(write);
      if (write.after === undefined) await fs.rm(write.file);
      else await writer(write.file, write.after, write.mode, 0o700);
    }
  } catch (error) {
    for (const write of done.reverse()) {
      if (await readTextFile(write.file) !== write.after) continue;
      if (write.before === undefined) await fs.rm(write.file, { force: true });
      else await writeFileAtomic(write.file, write.before, write.mode, 0o700);
    }
    await fs.rmdir(plan.directory).catch(() => undefined);
    throw error;
  } finally {
    await lock.close();
    const stat = await fs.lstat(lockFile).catch(() => undefined);
    if (stat?.isFile() && stat.dev === lockIdentity.dev && stat.ino === lockIdentity.ino) await fs.rm(lockFile);
  }
}

export async function checkNativeInstallation(directory: string): Promise<{ command?: McpCommand; reason?: string }> {
  try {
    const record = await readInstallation(directory);
    if (!record) throw new Error("No recorded native installation exists.");
    await verify(directory, record);
    for (const ref of record.references) {
      const text = await readTextFile(fileOf(directory, ref.file));
      for (const id of ["cavelon.native-approval", `cavelon.native-approval.${record.scope}`]) {
        const enabled = readJsoncEntry(text, ["plugin_enabled", id]);
        if ("error" in enabled) throw new Error(enabled.error);
        if (enabled.value === false) throw new Error("The person turned off the Cavelon plugin; enable it in the client only if intended.");
      }
    }
    const config = nativeClient(record.client)!.project()!;
    const entry = readNativeMcp(await readTextFile(fileOf(directory, record.mcp.file)), config);
    if ("error" in entry) throw new Error(entry.error);
    return { command: decodeMcpEntry(entry.value, config.entryFormat) };
  } catch (error) { return { reason: error instanceof Error ? error.message : String(error) }; }
}

export async function removeNativeInstallation(directory: string): Promise<{ removed: boolean; reason?: string }> {
  try {
    const record = await readInstallation(directory);
    if (!record) return { removed: true };
    await verify(directory, record);
    const writes = new Map<string, Write>();
    const replace = async (file: string, after: string | undefined) => {
      const before = await readTextFile(file);
      writes.set(file, { file, before, after, mode: await fs.stat(file).then(stat => stat.mode & 0o777, () => 0o600) });
    };
    for (const ref of record.references) {
      const file = fileOf(directory, ref.file);
      const before = writes.get(file)?.after ?? await readTextFile(file);
      const removed = removeJsoncMember(before, [ref.key], ref.member, { removeEmpty: !ref.kept });
      if (removed.outcome === "skipped") throw new Error(removed.reason);
      await replace(file, removed.empty && ref.created ? undefined : removed.content ?? before);
    }
    const mcpFile = fileOf(directory, record.mcp.file);
    const before = writes.get(mcpFile)?.after ?? await readTextFile(mcpFile);
    const config = nativeClient(record.client)!.project()!;
    const removed = removeJsoncEntry(before, config.keys, value => nativeEntryHash(value) === record.mcp.hash, record.mcp.kept);
    if (removed.outcome === "skipped") throw new Error(removed.reason);
    await replace(mcpFile, removed.empty && record.mcp.created ? undefined : removed.content ?? before);
    for (const name of [...Object.keys(record.files), "installation.json"]) await replace(path.join(directory, name), undefined);
    await applyNativeInstallation({ directory, outcome: "planned", writes: [...writes.values()].filter(write => write.before !== write.after) });
    await fs.rmdir(directory).catch(() => undefined);
    return { removed: true };
  } catch (error) { return { removed: false, reason: error instanceof Error ? error.message : String(error) }; }
}
