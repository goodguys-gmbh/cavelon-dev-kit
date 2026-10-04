import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { embeddedContent } from "./embedded.js";

function readVersion(): string {
  // dist/version.js and src/version.ts both sit one level below package.json.
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  try {
    return (JSON.parse(readFileSync(file, "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const KIT_VERSION = embeddedContent()?.version ?? readVersion();

/**
 * The contract versions this binary understands. `login` compares them with
 * the instance's `meta/capabilities` and warns on a mismatch instead of failing.
 */
export const SUPPORTED_CONTRACTS = {
  api_versions: ["v1"],
  package_versions: ["v1", "v2", "v3"],
} as const;
