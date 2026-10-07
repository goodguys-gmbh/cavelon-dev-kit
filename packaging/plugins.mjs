// The plugin packages a release carries, rendered from plugin/: the skills in
// plugin/skills/, the MCP entry in plugin/.mcp.json and the metadata of
// plugin/.claude-plugin/plugin.json stay the one source, and each package is
// that source in one client's format. Claude Code and Codex install plugin/
// itself from this repository's marketplaces; the others get:
//
//   cavelon-agent-plugin.tar.gz             Agent Plugins 1.0 (https://agent-plugins.org): Cursor,
//   cavelon-agent-plugin-windows.tar.gz     VS Code with GitHub Copilot, Copilot CLI and Kiro (a power)
//   <platform>.cavelon-gemini-extension.tar.gz   a Gemini CLI extension per platform (darwin, linux,
//                                           win32), named as `gemini extensions install` picks a
//                                           GitHub release's asset
//   cavelon-marketplace.tar.gz              plugin/ with both marketplaces, for Claude Code and Codex
//                                           without access to GitHub
//
// The names carry no version, as the executables' do, so that
// releases/latest/download/<name> always names the newest; the manifests inside do.
//
// The packages differ only in how the MCP server starts. With --server auto
// (the default) it is plugin/.mcp.json's entry on macOS and Linux (the
// `cavelon` on the PATH, else npx) and `cmd /c npx …` on Windows, where agents
// start servers without a shell; with --server installed it is `cavelon mcp`
// everywhere, for machines that have the executable and no registry access.
// The archives are deterministic: sorted, mtime 0, no owner.
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

export const AGENT_PLUGINS_SCHEMAS = {
  plugin: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  mcp: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
};
export const GEMINI_PLATFORMS = ["darwin", "linux", "win32"];
const INSTALL_DOCS = "https://github.com/goodguys-gmbh/cavelon-dev-kit/blob/main/docs/install";
// A Kiro power is loaded when a prompt names one of its keywords, so these stay specific.
const KEYWORDS = ["cavelon", "cavelon solution", "cavelon.yaml", "solution-as-code"];

/** Every file below `dir`, with forward slashes, sorted; a link or special file stops the render. */
function walk(dir, prefix = "") {
  const out = [];
  for (const entry of readdirSync(path.join(dir, prefix), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const stat = lstatSync(path.join(dir, relative));
    if (stat.isDirectory()) out.push(...walk(dir, relative));
    else if (stat.isFile()) out.push(relative);
    else throw new Error(`${path.join(dir, relative)} is neither a file nor a folder.`);
  }
  return out;
}

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

/** The three ways a package's MCP entry can start the server. */
function servers(source, version) {
  const entry = source.mcpServers?.cavelon;
  const pin = /@cavelon\/cli@[0-9]+\.[0-9]+/.exec(entry?.args?.join(" ") ?? "")?.[0];
  if (!entry || typeof entry.command !== "string" || !Array.isArray(entry.args) || !pin) {
    throw new Error("plugin/.mcp.json has no cavelon server that starts @cavelon/cli@<minor> through npx.");
  }
  const env = { ...entry.env };
  if (env.CAVELON_PLUGIN_VERSION !== version) throw new Error(`plugin/.mcp.json says CAVELON_PLUGIN_VERSION ${env.CAVELON_PLUGIN_VERSION}, cli/package.json ${version}.`);
  return {
    posix: { command: entry.command, args: entry.args, env },
    win32: { command: "cmd", args: ["/c", "npx", "-y", pin, "mcp"], env },
    installed: { command: "cavelon", args: ["mcp"], env },
  };
}

/** How a package's MCP entry starts the server, for its README. */
function startsAs(server) {
  if (server.command === "cavelon") return "as `cavelon mcp`: the `cavelon` on your PATH";
  const npx = server.args.slice(server.args.indexOf("npx")).join(" ");
  if (server.command === "cmd") return `as \`${npx}\` (through \`cmd /c\`), which needs Node.js`;
  return "as `cavelon mcp` when a `cavelon` is on your PATH, and otherwise through npx (Node.js)";
}

function readme(title, clients, page, version, server) {
  return `# ${title}

The Cavelon dev-kit ${version} for ${clients}: the four Cavelon skills
(\`skills/\`) and the \`cavelon\` MCP server, which starts ${startsAs(server)}.

Install it as ${page} says, then log in once with \`cavelon login\`
(or \`npx -y @cavelon/cli login\`). Licensed under the Apache License 2.0 (\`LICENSE\`).
`;
}

/**
 * Render every package into `out` (emptied first): the archives, and each one
 * unpacked under `out/unpacked/<archive name>/`. Returns the files written.
 */
export function renderPlugins({ root, version, server = "auto", out }) {
  if (!["auto", "installed"].includes(server)) throw new Error(`--server is auto or installed, not ${server}.`);
  const plugin = path.join(root, "plugin");
  const manifest = JSON.parse(readFileSync(path.join(plugin, ".claude-plugin", "plugin.json"), "utf8"));
  if (manifest.version !== version) throw new Error(`plugin/.claude-plugin/plugin.json is ${manifest.version}, cli/package.json ${version}.`);
  const starts = servers(JSON.parse(readFileSync(path.join(plugin, ".mcp.json"), "utf8")), version);
  const serverFor = (platform) => (server === "installed" ? starts.installed : platform === "win32" ? starts.win32 : starts.posix);
  const read = (...parts) => readFileSync(path.join(root, ...parts));
  const license = read("LICENSE");
  const skills = walk(path.join(plugin, "skills")).map((name) => [`skills/${name}`, read("plugin", "skills", ...name.split("/"))]);
  const about = {
    description: manifest.description,
    author: manifest.author,
    homepage: manifest.homepage,
    repository: manifest.repository,
    license: manifest.license,
  };

  const packages = [];
  for (const platform of ["posix", "win32"]) {
    const start = serverFor(platform);
    packages.push({
      file: `cavelon-agent-plugin${platform === "win32" ? "-windows" : ""}.tar.gz`,
      files: [
        ["plugin.json", json({ $schema: AGENT_PLUGINS_SCHEMAS.plugin, name: manifest.name, version, ...about, keywords: KEYWORDS })],
        ["mcp.json", json({ $schema: AGENT_PLUGINS_SCHEMAS.mcp, mcpServers: { cavelon: { type: "stdio", ...start } } })],
        ["README.md", readme("Cavelon plugin (Agent Plugins)", `Cursor, VS Code with GitHub Copilot, GitHub Copilot CLI and Kiro${platform === "win32" ? " on Windows" : " on macOS and Linux"}`, `the install page of your client in ${INSTALL_DOCS}/`, version, start)],
        ["LICENSE", license],
        ...skills,
      ],
    });
  }
  for (const platform of GEMINI_PLATFORMS) {
    const start = serverFor(platform);
    packages.push({
      file: `${platform}.cavelon-gemini-extension.tar.gz`,
      files: [
        // No contextFileName: Gemini CLI finds an extension's skills/ itself and loads each when it is needed.
        ["gemini-extension.json", json({ name: manifest.name, version, description: manifest.description, mcpServers: { cavelon: start } })],
        ["README.md", readme("Cavelon extension for Gemini CLI", "Gemini CLI", `${INSTALL_DOCS}/gemini-cli.md`, version, start)],
        ["LICENSE", license],
        ...skills,
      ],
    });
  }
  {
    const files = [
      [".claude-plugin/marketplace.json", read(".claude-plugin", "marketplace.json")],
      [".agents/plugins/marketplace.json", read(".agents", "plugins", "marketplace.json")],
      ...walk(plugin).map((name) => [`plugin/${name}`, read("plugin", ...name.split("/"))]),
      ["LICENSE", license],
    ];
    if (server === "installed") {
      // The plugin's own entry falls back to npx; here only the installed cavelon starts.
      files[files.findIndex(([name]) => name === "plugin/.mcp.json")][1] = json({ mcpServers: { cavelon: starts.installed } });
    }
    packages.push({ file: `cavelon-marketplace.tar.gz`, files });
  }

  rmSync(out, { recursive: true, force: true });
  const written = [];
  for (const pkg of packages) {
    const entries = pkg.files.map(([name, content]) => [name, Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8")]);
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, pkg.file), gzipSync(tar(entries), { level: 9 }));
    written.push(path.join(out, pkg.file));
    const tree = path.join(out, "unpacked", pkg.file.slice(0, -".tar.gz".length));
    for (const [name, content] of entries) {
      mkdirSync(path.dirname(path.join(tree, ...name.split("/"))), { recursive: true });
      writeFileSync(path.join(tree, ...name.split("/")), content);
    }
  }
  return written;
}

const BLOCK = 512;

function octal(value, width) {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

/** A USTAR archive of regular files, sorted by name; every name is plain ASCII and fits USTAR's fields. */
export function tar(entries) {
  const blocks = [];
  for (const [name, content] of [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!/^[\x21-\x7e]+$/.test(name) || name.split("/").some((part) => !part || part === "." || part === "..")) throw new Error(`"${name}" cannot go into a package.`);
    let prefix = "";
    let base = name;
    if (name.length > 100) {
      const at = name.lastIndexOf("/", 155);
      if (at <= 0 || name.length - at - 1 > 100) throw new Error(`"${name}" is too long for a package.`);
      prefix = name.slice(0, at);
      base = name.slice(at + 1);
    }
    const header = Buffer.alloc(BLOCK);
    header.write(base, 0, 100, "ascii");
    header.write(octal(0o644, 8), 100, "ascii");
    header.write(octal(0, 8), 108, "ascii");
    header.write(octal(0, 8), 116, "ascii");
    header.write(octal(content.length, 12), 124, "ascii");
    header.write(octal(0, 12), 136, "ascii");
    header.write("        ", 148, "ascii");
    header.write("0", 156, "ascii");
    header.write("ustar\0", 257, "ascii");
    header.write("00", 263, "ascii");
    header.write(prefix, 345, 155, "ascii");
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
    blocks.push(header, content);
    if (content.length % BLOCK) blocks.push(Buffer.alloc(BLOCK - (content.length % BLOCK)));
  }
  blocks.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(blocks);
}
