import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";
import { AGENT_VARIABLES, agentVariable } from "../../src/agent-env.js";
import { nativeStdioClient } from "../../src/native-approval/client.js";
import { seedQueryTool } from "../fake-database.js";
import { startFakeServer } from "../fake-server.js";
import { cli, login, type Sandbox } from "../helpers.js";

export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const selected = { solution_dir: "solutions/review", env: "test" };
export type Candidate = { command: string; args: string[] };
export type Observation = { code?: string; applied?: boolean; confirmations?: number; imports?: number;
  dialogs?: Array<{ title: string; answer: unknown; message_sha256: string }> };

export async function writeJson(file: string, value: unknown): Promise<void> {
  const temporary = file + ".tmp-" + process.pid;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(temporary, file);
}

// Supply an allowlist rather than copying a person's credential/provider environment.
export function isolatedEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "TERM"])
    if (process.env[key]) env[key] = process.env[key]!;
  return { ...env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, "AppData/Roaming"),
    LOCALAPPDATA: path.join(home, "AppData/Local"), XDG_CONFIG_HOME: path.join(home, "xdg"),
    XDG_DATA_HOME: path.join(home, "data"), XDG_STATE_HOME: path.join(home, "state"), XDG_CACHE_HOME: path.join(home, "cache"),
    CAVELON_CONFIG_DIR: path.join(home, "config"), CAVELON_CACHE_DIR: path.join(home, "cache"),
    CAVELON_CREDENTIAL_STORE: "file", CAVELON_NO_UPDATE_CHECK: "1", CAVELON_AGENT: "1",
    PI_CODING_AGENT_DIR: path.join(home, "pi"), PI_PROFILE: "default", OMP_PROFILE: "default", PI_OFFLINE: "1",
    CLINE_DIR: path.join(home, "cline"), GOOSE_PATH_ROOT: path.join(home, "goose"), GOOSE_DISABLE_KEYRING: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    KILO_DISABLE_MODELS_FETCH: "1", KILO_DISABLE_AUTOUPDATE: "1", QWEN_HOME: path.join(home, "qwen"),
    QWEN_CODE_SYSTEM_SETTINGS_PATH: path.join(home, "qwen-operator.json"), QWEN_CODE_SYSTEM_DEFAULTS_PATH: path.join(home, "qwen-defaults.json") };
}

export function requirePersonTerminal(env = process.env, tty = Boolean(process.stdin.isTTY && process.stdout.isTTY)): void {
  if (!tty || agentVariable(env)) throw new Error("This step requires the person's own interactive terminal outside a coding agent.");
}

export async function execute(candidate: Candidate, args: string[], env: Record<string, string>, cwd: string) {
  return new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
    const child = spawn(candidate.command, [...candidate.args, ...args], { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "", expired = false;
    const timer = setTimeout(() => { expired = true; child.kill(); }, 30_000);
    const kill = setTimeout(() => child.kill("SIGKILL"), 35_000);
    child.stdout.on("data", b => { out = (out + b).slice(-200_000); });
    child.stderr.on("data", b => { err = (err + b).slice(-200_000); });
    child.once("error", e => { clearTimeout(timer); clearTimeout(kill); reject(e); });
    child.once("close", code => {
      clearTimeout(timer); clearTimeout(kill);
      if (expired) reject(new Error("Qualification command exceeded 30 seconds."));
      else resolve({ code, out, err });
    });
  });
}

export function toolBody(result: any): any { return JSON.parse(result.content[0].text); }

export async function createApprovalFixture(directory: string, candidate: Candidate) {
  await fs.mkdir(directory, { recursive: false, mode: 0o700 });
  const home = path.join(directory, "private");
  await fs.mkdir(home, { mode: 0o700 });
  const env = isolatedEnv(home), sb: Sandbox = { home, env: personEnv(env), cleanup: () => undefined };
  const fake = await startFakeServer();
  try {
    fake.state.features.database_connector_enabled = true;
    const tenant = fake.addTenant("qualification", "Synthetic qualification");
    // Seeding uses the source test harness, never a person's login or credential store.
    await login(sb, fake.url, fake.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant }));
    const seeded = seedQueryTool(fake.state.db, tenant);
    const root = path.join(home, "multi solution root");
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, "cavelon.yaml"), stringify({ instance: fake.url, tenant }));
    for (const slug of ["review", "assistant"]) {
      const cwd = path.join(root, "solutions", slug);
      await fs.mkdir(cwd, { recursive: true });
      const initialized = await cli(sb, ["init", "--instance", fake.url, "--tenant", tenant, "--harness", slug], { cwd });
      if (initialized.code) throw new Error("Synthetic child init failed: " + initialized.stderr);
      fake.editConfig(tenant, pkg => {
        (pkg.agents as any[]).push({ ...structuredClone((pkg.agents as any[])[0]), slug: "obsolete", name: "Synthetic obsolete agent" });
        (pkg.tools as any[]).push(structuredClone(seeded.tool));
      });
      const pulled = await cli(sb, ["pull"], { cwd });
      if (pulled.code) throw new Error("Synthetic child pull failed: " + pulled.stderr);
      const agents = path.join(cwd, "package/agents.yaml"), tools = path.join(cwd, "package/tools.yaml");
      await fs.writeFile(agents, stringify((parse(await fs.readFile(agents, "utf8")) as any[]).filter(a => a.slug !== "obsolete")));
      const list = parse(await fs.readFile(tools, "utf8")) as any[];
      list.find(t => t.slug === "order_status").database_query.max_rows = 10;
      await fs.writeFile(tools, stringify(list));
      fake.state.configs.clear();
    }
    fake.state.requests.length = 0;
    fake.state.previewExtras = { summary: { creates: {}, updates: { tools: 1 }, deletes: { agents: 1 }, references: {} } };
    const bridge = (interactive = false) => nativeStdioClient({ ...candidate, args: [...candidate.args, "mcp"], env, cwd: root }, interactive, "qualification");
    const counts = () => ({ confirmations: fake.state.requests.filter(r => r.path === "/api/v1/confirmations").length,
      imports: fake.state.requests.filter(r => r.method === "POST" && r.path === "/api/v1/agent-graph/import").length });
    const evidence = (provenance: "simulated" | "unattested-observation", observations: Record<string, Observation>) => {
      const nonces = fake.state.requests.filter(r => r.path === "/api/v1/confirmations");
      const imports = fake.state.requests.filter(r => r.method === "POST" && r.path === "/api/v1/agent-graph/import");
      const request = imports[0], nonce = nonces[0];
      const issued = request ? fake.state.confirmationIds.get(String(request.headers["x-cavelon-confirmation"])) : undefined;
      const config = request ? fake.state.configs.get(tenant)?.pkg : undefined;
      return { schema_version: 1, provenance, actual_person_ui: false, fake_instance: true, real_model_calls: 0, database_executions: 0,
        production_actions: 0, platform: process.platform, arch: process.arch, multi_solution: true, ...counts(), observations,
        binding: { confirmation: nonce?.body ?? null, import: request ? { method: request.method, path: request.path, body: request.body } : null,
          token_tenant_request_bound: Boolean(issued?.used && issued.tenantId === tenant),
          selected_harness: Boolean(request && (request.body as any).harness_id === fake.state.harnesses.find(h => h.slug === "review")?.id) },
        query_max_rows: seeded.query.max_rows, obsolete_agent_deleted: Boolean(config && !(config.agents as any[]).some(a => a.slug === "obsolete")),
        completed_at: new Date().toISOString() };
    };
    return { directory, home, env, root, fake, seeded, candidate, bridge, counts, evidence, close: () => fake.close() };
  } catch (error) { await fake.close(); throw error; }
}

export type Evidence = ReturnType<Awaited<ReturnType<typeof createApprovalFixture>>["evidence"]> & {
  client?: string; client_version?: string; pinned_client_version?: string; route?: string; candidate?: { version: string; sha256: string };
};

export function checkEvidence(e: Evidence): void {
  if (e.schema_version !== 1 || !["simulated", "unattested-observation"].includes(e.provenance) || e.actual_person_ui !== false
    || e.fake_instance !== true || e.real_model_calls !== 0 || e.database_executions !== 0 || e.production_actions !== 0)
    throw new Error("Invalid evidence provenance or fixture boundary.");
  if (e.confirmations !== 1 || e.imports !== 1 || e.query_max_rows !== 10 || !e.obsolete_agent_deleted
    || !e.binding.token_tenant_request_bound || !e.binding.selected_harness
    || digest(e.binding.confirmation) !== digest(e.binding.import)) throw new Error("Guarded import count, result or exact binding failed.");
  for (const name of ["headless", "sibling", "decline"]) {
    if (!e.observations[name]?.code || e.observations[name]?.applied || e.observations[name]?.confirmations !== 0 || e.observations[name]?.imports !== 0)
      throw new Error("Missing zero-request refusal evidence: " + name);
  }
  if (!e.observations.approve?.applied) throw new Error("Missing successful fresh approval observation.");
  if (e.route === "native" && !e.observations.approve.dialogs?.some(d => d.title === "Cavelon: approve this exact change" && d.answer === true))
    throw new Error("Missing final native approval observation.");
}

export function personEnv(env: Record<string, string>): Record<string, string> {
  const clean = { ...env };
  for (const { variable } of AGENT_VARIABLES) delete clean[variable];
  return clean;
}
