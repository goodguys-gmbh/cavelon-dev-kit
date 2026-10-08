// Native clients already provide their runtime and UI. Bundle only our adapter
// and protocol dependencies; loading an offline adapter never runs npm/npx.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv.length > 2) throw new Error("Native assets are built only in dist/native-assets; output arguments are not accepted.");
const target = path.join(cli, "dist", "native-assets");
const version = JSON.parse(await readFile(path.join(cli, "package.json"), "utf8")).version;
const entries = ["opencode-server", "opencode-tui", "pi-extension", "kilo-server", "kilo-tui", "omp-extension"];
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
const files = [];
const dependencies = new Set();
const add = async (name, content) => {
  const bytes = Buffer.from(Buffer.from(content).toString("utf8").replaceAll("\r\n", "\n"));
  await writeFile(path.join(target, name), bytes);
  files.push({ path: name, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
};
for (const entry of entries) {
  const result = await build({
    absWorkingDir: cli,
    entryPoints: [`src/native-approval/${entry}.ts`], bundle: true, write: false,
    platform: "node", target: "node20.3", format: "esm", legalComments: "eof",
    // jsonc-parser's UMD entry hides relative requires from a static bundler.
    mainFields: ["module", "main"],
    banner: { js: 'import { createRequire as createNativeRequire } from "node:module"; const require = createNativeRequire(import.meta.url);' },
    metafile: true,
  });
  if (Object.keys(result.metafile.inputs).some(name => name.includes("keyring") || name.endsWith(".node"))) {
    throw new Error("A native adapter must never carry the CLI's credential store binding.");
  }
  for (const input of Object.keys(result.metafile.inputs)) {
    if (!input.startsWith("node_modules/")) continue;
    const words = input.split("/");
    dependencies.add(words[1].startsWith("@") ? `${words[1]}/${words[2]}` : words[1]);
  }
  await add(`${entry}.mjs`, result.outputFiles[0].contents);
}
for (const [name, source] of [
  ["LICENSE", "../LICENSE"],
  ["MCP-SDK-LICENSE", "node_modules/@modelcontextprotocol/sdk/LICENSE"],
  ["JSONC-LICENSE", "node_modules/jsonc-parser/LICENSE.md"],
  ["ZOD-LICENSE", "node_modules/zod/LICENSE"],
  ["TYPEBOX-LICENSE", "node_modules/typebox/license"],
]) await add(name, await readFile(path.resolve(cli, source)));
const notices = [];
for (const name of [...dependencies].toSorted((a, b) => a.localeCompare(b, "en"))) {
  const directory = path.join(cli, "node_modules", name);
  const metadata = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
  let license;
  for (const file of ["LICENSE", "LICENSE.md", "LICENSE.txt", "license"]) {
    try { license = await readFile(path.join(directory, file), "utf8"); break; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  if (!license) throw new Error(`No redistribution license for bundled dependency ${name}.`);
  notices.push(`${name} ${metadata.version}\n${license.replaceAll("\r\n", "\n")}`);
}
await add("THIRD-PARTY-NOTICES", notices.join("\n\n---\n\n"));
await writeFile(path.join(target, "manifest.json"), JSON.stringify({
  format: 1, version,
  entries: { omp: ["omp-extension.mjs"], opencode: ["opencode-server.mjs", "opencode-tui.mjs"], pi: ["pi-extension.mjs"], kilo: ["kilo-server.mjs", "kilo-tui.mjs"] },
  files: files.toSorted((a, b) => a.path.localeCompare(b.path, "en")),
}, null, 2) + "\n");
