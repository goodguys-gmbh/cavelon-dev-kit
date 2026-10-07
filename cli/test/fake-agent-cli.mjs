/* global process */
// A stand-in for the `claude`, `codex`, `gemini` and `cavelon` commands in the setup
// tests: it answers the plugin commands `cavelon setup` runs, keeps what is
// installed in a file in the test's home folder, and logs every call. As
// `cavelon mcp` it answers an MCP initialize. It never touches a real agent.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const [agent, ...args] = process.argv.slice(2);
const home = process.env.HOME || process.env.USERPROFILE;
const stateFile = path.join(home, `.fake-${agent}.json`);
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { marketplaces: [], plugins: [] };
const out = (value) => process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);
const save = () => writeFileSync(stateFile, JSON.stringify(state));
const without = (list, item) => list.filter((x) => x !== item);
const call = args.join(" ");

appendFileSync(path.join(home, `.fake-${agent}.log`), `${call}\n`);
if (process.env.FAKE_AGENT_FAIL && call.startsWith(process.env.FAKE_AGENT_FAIL)) {
  process.stderr.write(`${agent}: could not reach github.com\n`);
  process.exit(1);
}

if (agent === "cavelon" && call === "mcp") {
  let buffer = "";
  process.stdin.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const line = buffer.split("\n")[0];
    if (!buffer.includes("\n")) return;
    const request = JSON.parse(line);
    out(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: request.params.protocolVersion, capabilities: {}, serverInfo: { name: "cavelon", version: "9.9.9" } } }));
  });
  process.stdin.on("end", () => process.exit(0));
} else if (agent === "gemini" && /^extensions install https:\/\/github\.com\/goodguys-gmbh\/cavelon-dev-kit --ref v\S+ --consent$/.test(call)) {
  // Gemini CLI trusts the folder an install runs in; the test checks which one that was.
  writeFileSync(path.join(home, ".fake-gemini.cwd"), process.cwd());
  const extension = path.join(process.env.GEMINI_CLI_HOME || home, ".gemini", "extensions", "cavelon");
  mkdirSync(extension, { recursive: true });
  writeFileSync(path.join(extension, "gemini-extension.json"), JSON.stringify({ name: "cavelon", version: "0.1.2" }));
  out('Extension "cavelon" installed successfully and enabled.');
} else if (agent === "gemini" && call === "extensions uninstall cavelon") {
  rmSync(path.join(process.env.GEMINI_CLI_HOME || home, ".gemini", "extensions", "cavelon"), { recursive: true, force: true });
} else if (call === "plugin list --json") {
  if (agent === "claude") out(state.plugins.map((id) => ({ id, version: "0.1.2", scope: "user", enabled: true })));
  else out({ installed: state.plugins.map((id) => ({ pluginId: id, installed: true, enabled: true })) });
} else if (call === "plugin marketplace list --json") {
  const list = state.marketplaces.map((name) => ({ name, source: "github", repo: "goodguys-gmbh/cavelon-dev-kit" }));
  out(agent === "claude" ? list : { marketplaces: list });
} else if (call === "plugin marketplace add goodguys-gmbh/cavelon-dev-kit") {
  state.marketplaces.push("cavelon-dev-kit");
  save();
  out("Successfully added marketplace: cavelon-dev-kit");
} else if (call === "plugin marketplace remove cavelon-dev-kit") {
  state.marketplaces = without(state.marketplaces, "cavelon-dev-kit");
  save();
} else if (call === "plugin install cavelon@cavelon-dev-kit --scope user" || call === "plugin add cavelon@cavelon-dev-kit") {
  if (!state.marketplaces.includes("cavelon-dev-kit")) {
    process.stderr.write("Marketplace cavelon-dev-kit not found\n");
    process.exit(1);
  }
  state.plugins.push("cavelon@cavelon-dev-kit");
  save();
} else if (call === "plugin uninstall cavelon@cavelon-dev-kit --scope user" || call === "plugin remove cavelon@cavelon-dev-kit") {
  state.plugins = without(state.plugins, "cavelon@cavelon-dev-kit");
  save();
} else {
  process.stderr.write(`${agent}: unknown command: ${call}\n`);
  process.exit(2);
}
