import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { embeddedContent } from "./embedded.js";
import { KIT_VERSION } from "./version.js";

export interface NativeAsset { path: string; content: string }
interface Manifest {
  format: number;
  version: string;
  files: Array<{ path: string; size: number; sha256: string }>;
}

async function readAssets(): Promise<NativeAsset[]> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // A checkout runs src/ in tests and dist/ in its CLI; neither fetches assets.
  for (const directory of [path.join(here, "native-assets"), path.resolve(here, "..", "dist", "native-assets")]) {
    let names: string[];
    try { names = await fs.readdir(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    return Promise.all(names.map(async name => ({ path: name, content: await fs.readFile(path.join(directory, name), "utf8") })));
  }
  throw new Error("Missing native assets; build or reinstall Cavelon.");
}

/** The npm and executable readers verify identical versioned assets before setup. */
export async function bundledNativeAssets(): Promise<NativeAsset[]> {
  const assets = embeddedContent()?.nativeAssets ?? await readAssets();
  const raw = assets.find(asset => asset.path === "manifest.json");
  if (!raw) throw new Error("Missing native asset manifest; reinstall Cavelon.");
  const manifest = JSON.parse(raw.content) as Manifest;
  if (manifest.format !== 1 || manifest.version !== KIT_VERSION || !Array.isArray(manifest.files)
    || assets.length !== manifest.files.length + 1) throw new Error("Invalid native asset manifest; reinstall Cavelon.");
  const seen = new Set<string>();
  for (const listed of manifest.files) {
    if (typeof listed.path !== "string" || !/^[a-zA-Z0-9_.-]+$/.test(listed.path) || seen.has(listed.path) || listed.path === "manifest.json") {
      throw new Error("Invalid native asset path.");
    }
    seen.add(listed.path);
    const asset = assets.find(asset => asset.path === listed.path);
    if (!asset || Buffer.byteLength(asset.content) !== listed.size
      || createHash("sha256").update(asset.content).digest("hex") !== listed.sha256) throw new Error("Native asset checksum mismatch; reinstall Cavelon.");
  }
  return assets.toSorted((a, b) => a.path.localeCompare(b.path, "en"));
}
