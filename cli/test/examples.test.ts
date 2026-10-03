import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { startFakeServer, type FakeServer } from "./fake-server.js";
import { cli, login, sandbox, type Sandbox } from "./helpers.js";

/**
 * The folders in examples/ are solutions a developer copies, so each must
 * pass `cavelon validate` against the package schema the contract snapshot
 * publishes, without warnings, and each agent that is given a knowledge base
 * must have a tool to search it.
 */

const EXAMPLES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../examples");
/** The built-in the instance's docs name for searching knowledge bases. */
const SEARCH_TOOL = "search_documents";

interface Assignment {
  tool_slug?: string;
  skill_slug?: string;
  knowledge_base_name?: string;
}
interface Agent {
  slug: string;
  harness_slug: string;
  output_mode?: string;
  tool_assignments?: Assignment[];
  skill_assignments?: Assignment[];
}
interface Skill {
  slug: string;
  tool_assignments?: Assignment[];
  knowledge_base_assignments?: Assignment[];
}
interface Node {
  slug: string;
  node_type: string;
  harness_slug: string;
  config: Record<string, unknown>;
}
interface Edge {
  from_node_ref: { kind: string; slug: string };
  to_node_ref: { kind: string; slug: string };
  edge_type: string;
  harness_slug: string;
  config: Record<string, unknown>;
}
interface Suite {
  name: string;
  harness_slug: string;
  test_cases: Array<{ name: string; steps: Array<{ user_message: string; evaluation_criteria?: string[] }> }>;
}

let server: FakeServer;
let sb: Sandbox;
let scratch: string;

beforeAll(async () => {
  server = await startFakeServer();
  sb = sandbox();
  const tenant = server.addTenant("acme", "Acme");
  await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant }));
  scratch = mkdtempSync(path.join(os.tmpdir(), "cavelon-example-"));
});
afterAll(async () => {
  sb.cleanup();
  rmSync(scratch, { recursive: true, force: true });
  await server.close();
});

function reader(example: string) {
  return <T>(...parts: string[]) => parse(readFileSync(path.join(EXAMPLES, example, ...parts), "utf8")) as T;
}

describe.each(["support-faq", "expense-approval"])("examples/%s", (example) => {
  const read = reader(example);

  it("validates against the snapshot's package schema, then offline from the cache", async () => {
    // A copy, as a developer makes one: validate's cache never lands in the repository.
    const dir = path.join(scratch, example);
    cpSync(path.join(EXAMPLES, example), dir, { recursive: true });
    const online = await cli(sb, ["validate", "--instance", server.url, "--json"], { cwd: dir });
    expect(online.code, online.stdout + online.stderr).toBe(0);
    expect(online.json()).toMatchObject({ valid: true, schema_version: "v3", error_count: 0, errors: 0, warning_count: 0, warnings: [], findings: [] });
    expect(online.json<{ sections: number }>().sections).toBeGreaterThanOrEqual(5);

    server.state.requests.length = 0;
    const offline = await cli(sb, ["validate", "--offline", "--instance", server.url, "--json"], { cwd: dir });
    expect(offline.code, offline.stdout + offline.stderr).toBe(0);
    expect(offline.json()).toMatchObject({ valid: true, error_count: 0, warning_count: 0, warnings: [] });
    expect(server.state.requests).toEqual([]);
  });

  it("is one solution: the package, tests and env name the harness in cavelon.yaml", () => {
    const project = read<{ harness: string; package_version: string }>("cavelon.yaml");
    const harnesses = read<Array<{ slug: string }>>("package", "harnesses.yaml");
    const agents = read<Agent[]>("package", "agents.yaml");
    const skills = read<Skill[]>("package", "skills.yaml");
    const kbs = read<Array<{ name: string }>>("package", "knowledge_bases.yaml");

    expect(harnesses.map((h) => h.slug)).toEqual([project.harness]);
    expect(read<{ harness: string }>("env", "test.yaml").harness).toBe(project.harness);
    for (const agent of agents) {
      expect(agent.harness_slug).toBe(project.harness);
      for (const a of agent.skill_assignments ?? []) expect(skills.map((s) => s.slug)).toContain(a.skill_slug);
    }
    for (const skill of skills) {
      for (const a of skill.knowledge_base_assignments ?? []) expect(kbs.map((k) => k.name)).toContain(a.knowledge_base_name);
    }
    expect(agents.filter((a) => (a as { is_entrypoint?: boolean }).is_entrypoint).length).toBe(1);
  });

  it("gives every agent with a knowledge base the search tool", () => {
    const agents = read<Agent[]>("package", "agents.yaml");
    const skills = read<Skill[]>("package", "skills.yaml");
    for (const agent of agents) {
      const held = (agent.skill_assignments ?? []).map((a) => skills.find((s) => s.slug === a.skill_slug)!);
      const named = held.flatMap((s) => s.knowledge_base_assignments ?? []);
      if (!named.length) continue;
      const tools = [...(agent.tool_assignments ?? []), ...held.flatMap((s) => s.tool_assignments ?? [])].map((a) => a.tool_slug);
      expect(tools, `agent ${agent.slug}`).toContain(SEARCH_TOOL);
    }
    expect(agents.some((a) => (a.skill_assignments ?? []).length)).toBe(true);
  });
});

describe("examples/expense-approval", () => {
  const read = reader("expense-approval");
  const registry = () => read<{ orchestration_nodes: Node[]; graph_edges: Edge[] }>("package", "registry_entities.yaml");

  it("is a pipeline: chat → agent → router → approval → output, every edge between nodes it has", () => {
    const { orchestration_nodes: nodes, graph_edges: edges } = registry();
    const agents = read<Agent[]>("package", "agents.yaml");
    const types = new Set(nodes.map((n) => n.node_type));
    for (const type of ["chat_start", "router", "transform", "approval", "output"]) expect(types).toContain(type);
    for (const n of nodes) expect(n.harness_slug).toBe("expense-approval");

    const exists = (ref: { kind: string; slug: string }) =>
      ref.kind === "agent" ? agents.some((a) => a.slug === ref.slug) : nodes.some((n) => n.slug === ref.slug);
    for (const e of edges) {
      expect(exists(e.from_node_ref), JSON.stringify(e.from_node_ref)).toBe(true);
      expect(exists(e.to_node_ref), JSON.stringify(e.to_node_ref)).toBe(true);
      expect(e.harness_slug).toBe("expense-approval");
    }
    // The agents feed routers that read their fields, so both answer in structured JSON.
    for (const a of agents) expect(a.output_mode).toBe("structured_json");

    // Each router has exactly one default, and the router after the approval reads the decision.
    for (const router of nodes.filter((n) => n.node_type === "router")) {
      const out = edges.filter((e) => e.from_node_ref.slug === router.slug);
      expect(out.length, router.slug).toBeGreaterThanOrEqual(2);
      expect(out.filter((e) => e.config.default === true).length, router.slug).toBe(1);
    }
    const approval = nodes.find((n) => n.node_type === "approval")!;
    expect(approval.config).toMatchObject({ title: expect.any(String), instructions: expect.any(String) });
    const after = edges.find((e) => e.from_node_ref.slug === approval.slug)!;
    const decision = edges.filter((e) => e.from_node_ref.slug === after.to_node_ref.slug && e.config.default !== true);
    expect(decision.map((e) => (e.config.condition as { path: string }).path)).toEqual(["approval.approved"]);
  });

  it("lets the approvers of R8.1 decide by the amount, never the requester (R8.2), as the schema checks", async () => {
    const { orchestration_nodes: nodes } = registry();
    const approval = nodes.find((n) => n.node_type === "approval")!;
    expect(approval.config.forbid_self_approval).toBe(true);
    const approvers = approval.config.approvers as { by: string; tiers: Array<{ up_to?: number; groups?: string[] }> };
    expect(approvers.by).toBe("$.previous_output.amount");
    expect(approvers.tiers.map((t) => t.up_to)).toEqual([500, 2000, undefined]);
    for (const t of approvers.tiers) expect(t.groups?.length).toBe(1);
    // The tier reads the amount the memo passes on.
    const memo = nodes.find((n) => n.slug === "decision-memo")!;
    expect((memo.config.mapping as Record<string, unknown>).amount).toBe("$.previous_output.amount");

    // The snapshot's package schema types the approval's config, so validate refuses a role the instance does not have.
    const dir = path.join(scratch, "expense-approval-unknown-role");
    cpSync(path.join(EXAMPLES, "expense-approval"), dir, { recursive: true });
    const file = path.join(dir, "package", "registry_entities.yaml");
    writeFileSync(file, readFileSync(file, "utf8").replace("groups: [management]", "roles: [managing_director]"));
    const result = await cli(sb, ["validate", "--instance", server.url, "--json"], { cwd: dir });
    expect(result.code).not.toBe(0);
    expect(JSON.stringify(result.json())).toContain("approvers.tiers[2].roles[0]");
  });

  it("has a suite with policy questions, a compliant request, a violation citing its rule, and the approval reached", () => {
    const suite = read<Suite>("tests", "acceptance.yaml");
    expect(suite.harness_slug).toBe("expense-approval");
    const criteria = (name: RegExp) =>
      suite.test_cases.filter((c) => name.test(c.name)).flatMap((c) => c.steps.flatMap((s) => s.evaluation_criteria ?? []));
    expect(suite.test_cases.filter((c) => /^Question/.test(c.name)).length).toBeGreaterThanOrEqual(2);
    expect(criteria(/compliant/).join("\n")).toMatch(/reached the approval/);
    expect(criteria(/violates a rule/).join("\n")).toMatch(/R\d+\.\d+.*violated/);
    expect(criteria(/^Approval/).join("\n")).toMatch(/reached the approval/);
  });
});
