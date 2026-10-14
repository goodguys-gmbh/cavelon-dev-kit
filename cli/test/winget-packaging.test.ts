import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv } from "ajv";
import addFormatsModule from "ajv-formats";
import { parse } from "yaml";
import { afterEach, beforeEach, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const addFormats = (addFormatsModule as unknown as { default?: typeof addFormatsModule }).default ?? addFormatsModule;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "cavelon-winget-"));
  mkdirSync(path.join(dir, "cli"));
  mkdirSync(path.join(dir, "release"));
  writeFileSync(path.join(dir, "cli/package.json"), JSON.stringify({ version: "0.2.7" }));
  writeFileSync(path.join(dir, "release/checksums.txt"), `${"a".repeat(64)}  cavelon-windows-x64.exe\n`);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it("renders one portable package using the community repository's recommended schemas", () => {
  const result = spawnSync(process.execPath, [path.join(root, "packaging/render.mjs"), "winget"], { cwd: dir, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  const output = path.join(dir, "packaging-out/winget/manifests/g/goodguys/Cavelon/0.2.7");
  expect(readdirSync(output).sort()).toEqual(["goodguys.Cavelon.installer.yaml", "goodguys.Cavelon.locale.en-US.yaml", "goodguys.Cavelon.yaml"]);
  const ajv = new Ajv({ strict: false, allErrors: true });
  (addFormats as unknown as (validator: Ajv) => void)(ajv);
  for (const [suffix, kind] of [["", "version"], [".installer", "installer"], [".locale.en-US", "defaultLocale"]]) {
    const schema = JSON.parse(readFileSync(path.join(root, "contracts/clients/winget-1.12.0", `${kind}.schema.json`), "utf8"));
    const text = readFileSync(path.join(output, `goodguys.Cavelon${suffix}.yaml`), "utf8");
    const manifest = parse(text);
    const validate = ajv.compile(schema);
    expect(validate(manifest), JSON.stringify(validate.errors)).toBe(true);
    expect(manifest.ManifestVersion).toBe(schema.properties.ManifestVersion.default);
    expect(text).toContain(`winget-manifest.${kind}.${manifest.ManifestVersion}.schema.json`);
  }
  expect(parse(readFileSync(path.join(output, "goodguys.Cavelon.installer.yaml"), "utf8"))).toMatchObject({
    InstallerType: "portable", Commands: ["cavelon"], Installers: [{ Architecture: "x64", InstallerSha256: "A".repeat(64),
      InstallerUrl: "https://github.com/goodguys-gmbh/cavelon-dev-kit/releases/download/v0.2.7/cavelon-windows-x64.exe" }],
  });
});

it("refuses to render a manifest without a verified executable checksum", () => {
  writeFileSync(path.join(dir, "release/checksums.txt"), "not-a-sha256  cavelon-windows-x64.exe\n");
  const result = spawnSync(process.execPath, [path.join(root, "packaging/render.mjs"), "winget"], { cwd: dir, encoding: "utf8" });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("has no SHA-256");
});
