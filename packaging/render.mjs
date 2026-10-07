// Write the package manager files and the plugin packages for the release.
// Run it from the repository's root:
//
//   node packaging/render.mjs homebrew [--base-url <url>]
//     packaging-out/homebrew/Formula/cavelon.rb, the formula for the tap goodguys-gmbh/homebrew-cavelon
//   node packaging/render.mjs winget [--base-url <url>]
//     packaging-out/winget/manifests/g/goodguys/Cavelon/<version>/*.yaml, the manifest for microsoft/winget-pkgs
//   node packaging/render.mjs plugins [--server auto|installed] [--out <dir>]
//     packaging-out/plugins/*.tar.gz, the plugin packages of the clients without
//     a marketplace in this repository (packaging/plugins.mjs says which), and
//     each one unpacked in packaging-out/plugins/unpacked/
//
// homebrew and winget read the release's checksums.txt in ./release; --base-url
// names the folder the executables are downloaded from (default: the GitHub
// release of that version), which CI points at a local server to test. Every
// kind takes the version from cli/package.json, which the release workflow
// checks against the tag.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { renderPlugins } from "./plugins.mjs";

const REPOSITORY = "goodguys-gmbh/cavelon-dev-kit";
const HOMEPAGE = `https://github.com/${REPOSITORY}`;
const DESCRIPTION = "CLI and MCP server for building Cavelon solutions with a coding agent";
// winget's identifier: Publisher.Package. Choose it for good before the first submission.
const WINGET_ID = "goodguys.Cavelon";
const WINGET_MANIFEST_VERSION = "1.9.0";
const OUT = path.resolve("packaging-out");

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { "base-url": { type: "string" }, server: { type: "string" }, out: { type: "string" } },
});
const [kind] = positionals;
const version = JSON.parse(readFileSync(path.resolve("cli", "package.json"), "utf8")).version;
if (!["homebrew", "winget", "plugins"].includes(kind) || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error("Usage, from the repository's root: node packaging/render.mjs homebrew|winget [--base-url <url>] | plugins [--server auto|installed] [--out <dir>]");
}

if (kind === "plugins") {
  const out = path.resolve(values.out ?? path.join(OUT, "plugins"));
  for (const file of renderPlugins({ root: path.resolve("."), version, server: values.server ?? "auto", out })) process.stdout.write(`${file}\n`);
  process.exit(0);
}

let base = values["base-url"] ?? `${HOMEPAGE}/releases/download/v${version}`;
while (base.endsWith("/")) base = base.slice(0, -1);

const sums = new Map();
for (const line of readFileSync(path.resolve("release", "checksums.txt"), "utf8").split("\n")) {
  const [sum, name] = line.trim().split(/\s+/);
  if (sum && name) sums.set(name.replace(/^\*/, ""), sum.toLowerCase());
}
function asset(name) {
  const sum = sums.get(name);
  if (!sum || !/^[0-9a-f]{64}$/.test(sum)) throw new Error(`checksums.txt has no SHA-256 for ${name}.`);
  return { url: `${base}/${name}`, sha256: sum };
}

function write(dir, name, content) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), content);
  process.stdout.write(`${path.join(dir, name)}\n`);
}

if (kind === "homebrew") {
  const block = (name) => {
    const a = asset(name);
    return `      url "${a.url}"\n      sha256 "${a.sha256}"`;
  };
  write(
    path.join(OUT, "homebrew", "Formula"),
    "cavelon.rb",
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
    assert_equal version.to_s, shell_output("#{bin}/cavelon --version").lines.first.strip
  end
end
`,
  );
} else {
  const exe = asset("cavelon-windows-x64.exe");
  const dir = path.join(OUT, "winget", "manifests", WINGET_ID[0].toLowerCase(), ...WINGET_ID.split("."), version);
  const header = (type) => `# yaml-language-server: $schema=https://aka.ms/winget-manifest.${type}.${WINGET_MANIFEST_VERSION}.schema.json\n`;
  write(
    dir,
    `${WINGET_ID}.yaml`,
    `${header("version")}
PackageIdentifier: ${WINGET_ID}
PackageVersion: ${version}
DefaultLocale: en-US
ManifestType: version
ManifestVersion: ${WINGET_MANIFEST_VERSION}
`,
  );
  write(
    dir,
    `${WINGET_ID}.installer.yaml`,
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
    dir,
    `${WINGET_ID}.locale.en-US.yaml`,
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
