// Write the package manager files for one release from its checksums.txt:
//
//   node packaging/render.mjs homebrew --version 0.1.3 --checksums checksums.txt --out <dir>
//     <dir>/Formula/cavelon.rb, the formula for the tap goodguys-gmbh/homebrew-cavelon
//   node packaging/render.mjs winget --version 0.1.3 --checksums checksums.txt --out <dir>
//     <dir>/manifests/g/goodguys/Cavelon/0.1.3/*.yaml, the manifest for microsoft/winget-pkgs
//
// --base-url names the folder the executables are downloaded from (default: the
// GitHub release of that version); CI points it at a local server to test.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const REPOSITORY = "goodguys-gmbh/cavelon-dev-kit";
const HOMEPAGE = `https://github.com/${REPOSITORY}`;
const DESCRIPTION = "CLI and MCP server for building Cavelon solutions with a coding agent";
// winget's identifier: Publisher.Package. Choose it for good before the first submission.
const WINGET_ID = "goodguys.Cavelon";
const WINGET_MANIFEST_VERSION = "1.9.0";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    version: { type: "string" },
    checksums: { type: "string" },
    "base-url": { type: "string" },
    out: { type: "string" },
  },
});
const [kind] = positionals;
const version = (values.version ?? "").replace(/^v/, "");
if (!["homebrew", "winget"].includes(kind) || !/^\d+\.\d+\.\d+$/.test(version) || !values.checksums || !values.out) {
  throw new Error("Usage: node packaging/render.mjs homebrew|winget --version X.Y.Z --checksums checksums.txt --out <dir> [--base-url <url>]");
}
let base = values["base-url"] ?? `${HOMEPAGE}/releases/download/v${version}`;
while (base.endsWith("/")) base = base.slice(0, -1);

const sums = new Map();
for (const line of readFileSync(values.checksums, "utf8").split("\n")) {
  const [sum, name] = line.trim().split(/\s+/);
  if (sum && name) sums.set(name.replace(/^\*/, ""), sum.toLowerCase());
}
function asset(name) {
  const sum = sums.get(name);
  if (!sum || !/^[0-9a-f]{64}$/.test(sum)) throw new Error(`checksums.txt has no SHA-256 for ${name}.`);
  return { url: `${base}/${name}`, sha256: sum };
}

function write(file, content) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  process.stdout.write(`${file}\n`);
}

if (kind === "homebrew") {
  const block = (name) => {
    const a = asset(name);
    return `      url "${a.url}"\n      sha256 "${a.sha256}"`;
  };
  write(
    path.join(values.out, "Formula", "cavelon.rb"),
    `# Written by the release workflow of ${HOMEPAGE} (packaging/render.mjs).
class Cavelon < Formula
  desc "${DESCRIPTION}"
  homepage "${HOMEPAGE}"
  version "${version}"
  license "Apache-2.0"

  on_macos do
    on_arm do
${block("cavelon-darwin-arm64")}
    end
    on_intel do
${block("cavelon-darwin-x64")}
    end
  end

  on_linux do
    on_arm do
${block("cavelon-linux-arm64")}
    end
    on_intel do
${block("cavelon-linux-x64")}
    end
  end

  def install
    bin.install Dir["cavelon-*"].first => "cavelon"
  end

  test do
    assert_equal version.to_s, shell_output("#{bin}/cavelon --version").strip
  end
end
`,
  );
} else {
  const exe = asset("cavelon-windows-x64.exe");
  const dir = path.join(values.out, "manifests", WINGET_ID[0].toLowerCase(), ...WINGET_ID.split("."), version);
  const header = (type) => `# yaml-language-server: $schema=https://aka.ms/winget-manifest.${type}.${WINGET_MANIFEST_VERSION}.schema.json\n`;
  write(
    path.join(dir, `${WINGET_ID}.yaml`),
    `${header("version")}
PackageIdentifier: ${WINGET_ID}
PackageVersion: ${version}
DefaultLocale: en-US
ManifestType: version
ManifestVersion: ${WINGET_MANIFEST_VERSION}
`,
  );
  write(
    path.join(dir, `${WINGET_ID}.installer.yaml`),
    `${header("installer")}
PackageIdentifier: ${WINGET_ID}
PackageVersion: ${version}
InstallerType: portable
Commands:
  - cavelon
Installers:
  - Architecture: x64
    InstallerUrl: ${exe.url}
    InstallerSha256: ${exe.sha256.toUpperCase()}
ManifestType: installer
ManifestVersion: ${WINGET_MANIFEST_VERSION}
`,
  );
  write(
    path.join(dir, `${WINGET_ID}.locale.en-US.yaml`),
    `${header("defaultLocale")}
PackageIdentifier: ${WINGET_ID}
PackageVersion: ${version}
PackageLocale: en-US
Publisher: goodguys GmbH
PublisherUrl: https://github.com/goodguys-gmbh
PackageName: cavelon
PackageUrl: ${HOMEPAGE}
License: Apache-2.0
LicenseUrl: ${HOMEPAGE}/blob/main/LICENSE
ShortDescription: ${DESCRIPTION}.
Description: The Cavelon dev-kit's command-line tool and local MCP server. It previews and imports solution packages, uploads knowledge, runs test suites, reads traces and activates solutions.
Moniker: cavelon
Tags:
  - cavelon
  - cli
  - mcp
ReleaseNotesUrl: ${HOMEPAGE}/releases/tag/v${version}
ManifestType: defaultLocale
ManifestVersion: ${WINGET_MANIFEST_VERSION}
`,
  );
}
