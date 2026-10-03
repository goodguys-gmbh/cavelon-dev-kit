import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { startFakeServer, type FakeServer } from "./fake-server.js";
import { cli, login, sandbox, type Sandbox } from "./helpers.js";

/**
 * examples/support-faq/ is a solution a
 * developer copies, so it must pass `cavelon validate` against the package
 * schema the contract snapshot publishes, without warnings.
 */

const EXAMPLE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../examples/support-faq");

let server: FakeServer;
let sb: Sandbox;
let dir: string;

beforeAll(async () => {
  server = await startFakeServer();
  sb = sandbox();
  const tenant = server.addTenant("acme", "Acme");
  await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant }));
  // A copy, as a developer makes one: validate's cache never lands in the repository.
  dir = path.join(mkdtempSync(path.join(os.tmpdir(), "cavelon-example-")), "support-faq");
  cpSync(EXAMPLE, dir, { recursive: true });
});
afterAll(async () => {
  sb.cleanup();
  rmSync(path.dirname(dir), { recursive: true, force: true });
  await server.close();
});

describe("examples/support-faq", () => {
  it("validates against the snapshot's package schema, then offline from the cache", async () => {
    const online = await cli(sb, ["validate", "--instance", server.url, "--json"], { cwd: dir });
    expect(online.code, online.stdout + online.stderr).toBe(0);
    expect(online.json()).toMatchObject({ valid: true, schema_version: "v3", errors: 0, warnings: 0, findings: [] });
    expect(online.json<{ sections: number }>().sections).toBeGreaterThanOrEqual(5);

    server.state.requests.length = 0;
    const offline = await cli(sb, ["validate", "--offline", "--instance", server.url, "--json"], { cwd: dir });
    expect(offline.code, offline.stdout + offline.stderr).toBe(0);
    expect(offline.json()).toMatchObject({ valid: true, errors: 0, warnings: 0 });
    expect(server.state.requests).toEqual([]);
  });

  it("is one solution: the package, tests and env name the harness in cavelon.yaml", () => {
    const read = (...parts: string[]) => parse(readFileSync(path.join(EXAMPLE, ...parts), "utf8")) as unknown;
    const project = read("cavelon.yaml") as { harness: string; package_version: string };
    const harnesses = read("package", "harnesses.yaml") as Array<{ slug: string }>;
    const agents = read("package", "agents.yaml") as Array<{ harness_slug: string; skill_assignments: Array<{ skill_slug: string }> }>;
    const skills = read("package", "skills.yaml") as Array<{ slug: string; knowledge_base_assignments: Array<{ knowledge_base_name: string }> }>;
    const kbs = read("package", "knowledge_bases.yaml") as Array<{ name: string }>;
    const smoke = read("tests", "smoke.yaml") as { harness_slug: string; test_cases: unknown[] };

    expect(harnesses.map((h) => h.slug)).toEqual([project.harness]);
    expect((read("env", "test.yaml") as { harness: string }).harness).toBe(project.harness);
    expect(smoke.harness_slug).toBe(project.harness);
    expect(smoke.test_cases.length).toBeGreaterThan(0);
    for (const agent of agents) {
      expect(agent.harness_slug).toBe(project.harness);
      for (const a of agent.skill_assignments) expect(skills.map((s) => s.slug)).toContain(a.skill_slug);
    }
    for (const skill of skills) {
      for (const a of skill.knowledge_base_assignments) expect(kbs.map((k) => k.name)).toContain(a.knowledge_base_name);
    }
  });
});
