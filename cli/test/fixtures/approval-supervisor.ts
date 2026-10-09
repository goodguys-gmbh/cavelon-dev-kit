import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { detectShell, shellWord } from "../../src/shell.js";
import { checkEvidence, createApprovalFixture, digest, execute, personEnv, requirePersonTerminal, selected, toolBody, writeJson, type Evidence, type Observation } from "./approval-qualification.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const pins = JSON.parse(await fs.readFile(path.join(repo, "cli/test/fixtures/coding-client-runtimes.json"), "utf8"));
const [command, ...args] = process.argv.slice(2);
const option = (name: string) => { const i = args.indexOf("--" + name); return i < 0 ? undefined : args[i + 1]; };
const run = path.resolve(option("run") ?? path.join(repo, ".wt/approval-qualification", new Date().toISOString().replaceAll(":", "-") + "-" + process.pid));
const write = (name: string, value: unknown) => writeJson(path.join(run, name), value);
const read = async (name: string) => JSON.parse(await fs.readFile(path.join(run, name), "utf8"));
const pause = () => new Promise(resolve => setTimeout(resolve, 100));
async function answer(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return await rl.question(prompt); } finally { rl.close(); }
}

async function start() {
  const name = option("client"), route = option("route") ?? "terminal", executable = option("executable");
  if (!name || !Object.hasOwn(pins, name) || !["terminal", "native"].includes(route) || !executable)
    throw new Error("start requires --client (one of seven pinned clients), --executable (installed standalone) and --route terminal|native.");
  if (route === "native") {
    requirePersonTerminal();
    if (!["pi", "omp"].includes(name)) throw new Error("The no-model native driver supports Pi/OMP only; other native/editor hosts remain separate gates.");
  }
  const deadlineSeconds = Number(option("deadline-seconds") ?? 1200);
  if (!Number.isInteger(deadlineSeconds) || deadlineSeconds < 5 || deadlineSeconds > 1200) throw new Error("Deadline must be 5..1200 seconds.");
  await fs.mkdir(path.dirname(run), { recursive: true });
  const fixture = await createApprovalFixture(run, { command: path.resolve(executable), args: [] });
  let child: ReturnType<typeof spawn> | undefined, ended = false, cancelled = false, succeeded = false;
  const cancel = () => { cancelled = true; };
  process.on("SIGINT", cancel); process.on("SIGTERM", cancel);
  const observations: Record<string, Observation> = {};
  let metadata: Partial<Evidence> = { client: name, pinned_client_version: pins[name].version, route };
  try {
    const bin = path.join(fixture.home, "bin");
    await fs.mkdir(bin);
    const installed = path.join(bin, process.platform === "win32" ? "cavelon.exe" : "cavelon");
    await fs.copyFile(path.resolve(executable), installed);
    if (process.platform !== "win32") await fs.chmod(installed, 0o700);
    fixture.env.PATH = bin + path.delimiter + fixture.env.PATH;
    fixture.candidate.command = installed;
    const version = await execute(fixture.candidate, ["--version"], fixture.env, fixture.root);
    if (version.code) throw new Error("Candidate version check failed.");
    metadata = { ...metadata, candidate: { version: version.out.trim(), sha256: createHash("sha256").update(await fs.readFile(installed)).digest("hex") } };
    const setup = await execute(fixture.candidate, ["setup", "--agents", name, "--yes", "--json"], fixture.env, fixture.root);
    await write("setup-local.json", setup);
    if (setup.code) throw new Error("Generated isolated client setup failed; see setup-local.json.");
    const headless = await fixture.bridge();
    try {
      const preview = toolBody(await headless.call("apply", { ...selected, mode: "replace" }));
      if (!preview.preview_id || !preview.show_to_person || !preview.database_queries?.would_write) throw new Error("Expected guarded deleting/query-change preview.");
      observations.headless = { code: toolBody(await headless.call("apply", { ...selected, confirm: preview.preview_id })).error?.code, ...fixture.counts() };
      observations.sibling = { code: toolBody(await headless.call("apply", { ...selected, solution_dir: "solutions/assistant", confirm: preview.preview_id })).error?.code, ...fixture.counts() };
      if (observations.headless?.code !== "confirm_needs_person" || observations.sibling?.code !== "preview_unknown"
        || fixture.counts().confirmations || fixture.counts().imports) throw new Error("Headless/sibling safety failed.");
    } finally { await headless.close(); }
    const deadline = Date.now() + deadlineSeconds * 1000;
    const wait = async (name: string): Promise<any> => {
      while (Date.now() < deadline && !cancelled && !ended) {
        try { return await read(name); } catch (e: any) { if (e.code !== "ENOENT") throw e; }
        await pause();
      }
      throw new Error(cancelled ? "Supervisor aborted." : ended ? "Native client exited before completion." : "Supervisor deadline expired.");
    };
    if (route === "native") {
      const runtime = path.resolve(option("runtime") ?? path.join(repo, ".wt/client-runtime", name));
      const pin = pins[name], packageDir = path.join(runtime, "node_modules", pin.package);
      const installedPackage = JSON.parse(await fs.readFile(path.join(packageDir, "package.json"), "utf8"));
      if (installedPackage.version !== pin.version) throw new Error("Client package differs from the maintained pin.");
      const entry = path.join(packageDir, name === "pi" ? "dist/bundle/cli.js" : "dist/cli.js");
      const engine = name === "omp" ? option("bun") : process.execPath;
      if (!engine) throw new Error("OMP requires --bun pointing to its pinned Bun runtime.");
      const checked = await execute({ command: engine, args: name === "pi" ? [entry] : [] }, ["--version"], fixture.env, fixture.root);
      if (checked.code || !checked.out.includes(name === "pi" ? pin.version : pin.bun)) throw new Error("Client/engine version mismatch.");
      if (name === "omp") {
        const clientVersion = await execute({ command: engine, args: [entry] }, ["--version"], fixture.env, fixture.root);
        if (clientVersion.code || !clientVersion.out.includes(pin.version)) throw new Error("OMP released CLI version mismatch.");
      }
      metadata.client_version = pin.version;
      const nativeDir = path.join(fixture.env.PI_CODING_AGENT_DIR!, "cavelon");
      const model = { providers: { fixture: { baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "synthetic-fixture-placeholder",
        models: [{ id: "synthetic-fixture", name: "Synthetic fixture", reasoning: false, input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 4096 }] } } };
      await fs.writeFile(path.join(fixture.env.PI_CODING_AGENT_DIR!, name === "pi" ? "models.json" : "models.yml"), JSON.stringify(model));
      if (name === "omp") await fs.writeFile(path.join(fixture.env.PI_CODING_AGENT_DIR!, "config.yml"),
        JSON.stringify({ startup: { setupWizard: false, checkUpdate: false, splash: false } }));
      const env = { ...fixture.env, CAVELON_APPROVAL_RUN: run, CAVELON_APPROVAL_ADAPTER: path.join(nativeDir, name + "-extension.mjs") };
      // The wrapper loads setup's unmodified bytes once; no autoload duplicate owner.
      child = spawn(engine, [entry, "--provider", "fixture", "--model", "synthetic-fixture", "--no-session", "--no-extensions", "-e", path.join(repo, "cli/test/fixtures/approval-native-driver.mjs"),
        ...(name === "pi" ? ["--offline"] : ["--no-title", "--no-lsp", "--no-pty"])], { env, cwd: fixture.root, stdio: "inherit", detached: process.platform !== "win32" });
      child.once("exit", () => { ended = true; });
      child.once("error", () => { ended = true; });
      const ready = await wait("native-ready.json");
      if (ready.hasUI !== true || ready.mode !== "tui" || !ready.tools.includes("mcp__cavelon__apply")) throw new Error("Actual native TUI/adapter not ready.");
      await write("native-case.json", { id: "decline" });
      observations.decline = { ...await wait("decline.json"), ...fixture.counts() };
      if (observations.decline?.code !== "confirm_declined" || !observations.decline?.dialogs?.some(d => d.answer === false)
        || fixture.counts().confirmations || fixture.counts().imports) throw new Error("Person refusal sent a guarded request.");
      await write("native-case.json", { id: "approve" });
      observations.approve = await wait("approve.json");
      if (!observations.approve?.dialogs?.some(d => d.title === "Cavelon: approve this exact change" && d.answer === true))
        throw new Error("No fresh final native yes was observed.");
    } else {
      for (const phase of ["decline", "approve"] as const) {
        const bridge = await fixture.bridge();
        let preview: any;
        try { preview = toolBody(await bridge.call("apply", { ...selected, mode: "replace" })); } finally { await bridge.close(); }
        await write("terminal-session.json", { phase, candidate: fixture.candidate, env: personEnv(fixture.env), cwd: path.join(fixture.root, "solutions/review"), preview });
        process.stdout.write(`\nPerson terminal ${phase}: node cli/scripts/qualify-approval.mjs terminal --run ${shellWord(run, detectShell(process.env))}\n`);
        observations[phase] = { ...await wait(phase + ".json"), ...fixture.counts() };
        if (phase === "decline" && (observations.decline?.code !== "person_declined" || fixture.counts().confirmations || fixture.counts().imports))
          throw new Error("Terminal refusal sent a guarded request.");
      }
    }
    const evidence = { ...fixture.evidence("unattested-observation", observations), ...metadata };
    checkEvidence(evidence);
    await write("evidence.json", evidence);
    succeeded = true;
    process.stdout.write("\nBinding checks passed. Person provenance remains unattested; review evidence.json and run attest from your own terminal.\n");
  } catch (error) {
    await write("failure.json", { ...fixture.evidence("unattested-observation", observations), ...metadata, failure: String(error) });
    throw error;
  } finally {
    let cleanupFailure: unknown;
    try { if (child?.pid) {
      if (process.platform === "win32") {
        await execute({ command: "taskkill.exe", args: [] }, ["/PID", String(child.pid), "/T", "/F"], fixture.env, fixture.root);
      } else {
        try { process.kill(-child.pid, "SIGTERM"); } catch (e: any) { if (e.code !== "ESRCH") cleanupFailure = e; }
        if (!ended) await Promise.race([new Promise(resolve => child!.once("exit", resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
        try { process.kill(-child.pid, "SIGKILL"); } catch (e: any) { if (e.code !== "ESRCH") cleanupFailure = e; }
      }
    } } catch (error) { cleanupFailure = error; }
    try { await fixture.close(); } catch (error) { cleanupFailure ??= error; }
    await fs.rm(path.join(run, "terminal-session.json"), { force: true });
    await write("supervisor-state.json", { status: succeeded && !cleanupFailure ? "completed" : "failed", cleanup_completed: !cleanupFailure,
      cleanup_failure: cleanupFailure ? String(cleanupFailure) : null });
    process.off("SIGINT", cancel); process.off("SIGTERM", cancel);
    process.stdout.write("Local evidence retained: " + run + "\n");
    if (cleanupFailure) { process.stderr.write("Owned process cleanup failed: " + String(cleanupFailure) + "\n"); process.exitCode = 1; }
  }
}

async function terminal() {
  requirePersonTerminal();
  const session = await read("terminal-session.json");
  if (!["decline", "approve"].includes(session.phase)) throw new Error("No active terminal phase.");
  const lock = await fs.open(path.join(run, "terminal-" + session.phase + ".lock"), "wx", 0o600);
  await lock.close();
  process.stdout.write(JSON.stringify(session.preview, null, 2) + "\n");
  const text = await answer(session.phase === "decline" ? "Decline this fake change by typing decline: " : "Review the fresh fake change; type apply to run the exact previewed command: ");
  if (session.phase === "decline") {
    if (text !== "decline") throw new Error("Decline phase requires a fresh person refusal.");
    await write("decline.json", { code: "person_declined", applied: false });
    return;
  }
  if (text !== "apply") throw new Error("Nothing sent; no fresh person request to apply.");
  if (digest(await read("terminal-session.json")) !== digest(session)) throw new Error("The exact preview changed while the person reviewed it; nothing sent.");
  const result = await execute(session.candidate, ["apply", "--confirm", session.preview.preview_id, "--env", "test", "--json"], session.env, session.cwd);
  const body = JSON.parse(result.out.trim());
  await write("approve.json", { applied: result.code === 0 && body.applied === true, code: body.error?.code });
  if (result.code) throw new Error("Person command failed: " + result.err);
}

async function check(attest = false) {
  const evidence: Evidence = await read("evidence.json");
  checkEvidence(evidence);
  if (evidence.provenance !== "simulated") {
    const state = await read("supervisor-state.json");
    if (state.status !== "completed" || state.cleanup_completed !== true) throw new Error("Supervisor/cleanup did not complete safely.");
  }
  const hash = digest(evidence);
  if (attest) {
    requirePersonTerminal();
    if (evidence.provenance === "simulated") throw new Error("Simulated protocol checks cannot become person evidence.");
    process.stdout.write(JSON.stringify(evidence, null, 2) + "\n");
    const statement = "I observed " + hash;
    if (await answer(`Only after observing the fresh refusal/approval on the named host, type ${statement}: `) !== statement)
      throw new Error("Person observation was not attested.");
    const surface = await answer("Actual host surface (native-windows, wsl, macos, linux; include editor name/version if used): ");
    if (!/^(native-windows|wsl|macos|linux)( |$)/.test(surface) || surface.length > 200) throw new Error("Name the actual host surface.");
    await write("person-attestation.json", { provenance: "operator-attested-person", evidence_sha256: hash, host_surface: surface, attested_at: new Date().toISOString() });
  }
  let attestation: any;
  try { attestation = await read("person-attestation.json"); } catch (e: any) { if (e.code !== "ENOENT") throw e; }
  const attested = evidence.provenance !== "simulated" && attestation?.provenance === "operator-attested-person" && attestation.evidence_sha256 === hash;
  const report = { ...evidence, provenance: attested ? "operator-attested-person" : evidence.provenance,
    operator_attestation_valid: attested, operator_attested_coverage: attested ? (evidence.route === "native" ? "native-ui" : "own-terminal") : null,
    attestation: attested ? attestation : null, binding_checks_passed: true,
    platform_acceptance: "requires-maintainer-review" };
  await write("export.json", report);
  process.stdout.write(JSON.stringify({ binding_checks_passed: true, operator_attestation_valid: attested, export: path.join(run, "export.json") }) + "\n");
  if (!attested && evidence.provenance !== "simulated") process.exitCode = 2;
}

try {
  switch (command) {
    case "start": await start(); break;
    case "terminal": await terminal(); break;
    case "check": await check(); break;
    case "attest": await check(true); break;
    default: process.stdout.write("Approval supervisor: start --client NAME --executable PATH [--route terminal|native] [--run DIRECTORY] [--runtime DIRECTORY] [--bun PATH] [--deadline-seconds 5..1200]; terminal|attest|check --run DIRECTORY.\n");
  }
} catch (error) { process.stderr.write(String(error) + "\n"); process.exitCode = 1; }
