// Bundle the plugin's skills into the package, so `cavelon init --agents` can
// write them into a solution: ../plugin/skills/ → dist/skills/. The repository's
// LICENSE goes along (dist/LICENSE): npm packs only files below cli/.
import { copyFileSync, cpSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.resolve(cli, "..", "plugin", "skills");
const target = path.join(cli, "dist", "skills");
if (!existsSync(source)) throw new Error(`No skills at ${source}.`);
rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });
copyFileSync(path.resolve(cli, "..", "LICENSE"), path.join(cli, "dist", "LICENSE"));
