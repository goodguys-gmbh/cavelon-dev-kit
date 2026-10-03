import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PackageSchema } from "../src/contracts.js";
import { parseLimits } from "../src/limits.js";
import { checkPackage } from "../src/package-check.js";
import { CONTRACTS } from "./fake-server.js";

/**
 * Validate warns, from the published branch
 * concurrency, when a fan-out or Map loop asks for more branches than the
 * width, and when the tenant runs them in sequence. Never an error, and
 * nothing on an instance that publishes no branch concurrency.
 */

type LimitEntry = Record<string, unknown> & { key: string };

const caps = () => JSON.parse(readFileSync(path.join(CONTRACTS, "meta-capabilities.json"), "utf8")) as { limits: { values: LimitEntry[] } };
const schema = JSON.parse(readFileSync(path.join(CONTRACTS, "meta-package-schema-v3.json"), "utf8")) as PackageSchema;

/** The snapshot's limits, with the entries edited. */
function limits(edit: (values: LimitEntry[]) => LimitEntry[] = (v) => v) {
  const snapshot = caps();
  return parseLimits({ limits: { ...snapshot.limits, values: edit(snapshot.limits.values) } });
}

/** The tenant's flag off: branches run in sequence. */
const flagOff = (values: LimitEntry[]) =>
  values.map((v) =>
    v.key === "orchestration_parallel_branches"
      ? {
          ...v,
          value: false,
          switches: (v.switches as Array<Record<string, unknown>>).map((s) => (s.source === "tenant" ? { ...s, enabled: false } : s)),
        }
      : v,
  );

/** A package with a fan-out on a graph edge, a fan-out on an agent handoff and a sequential loop. */
const pkg = {
  registry_entities: {
    orchestration_nodes: [{ slug: "loop", node_type: "for_each_item", config: { source: "$.items", mode: "sequential" } }],
    graph_edges: [
      { from_node_ref: { kind: "agent", slug: "triage" }, to_node_ref: { kind: "agent", slug: "legal" }, edge_type: "pipeline", config: { fanout: true, max_concurrency: 20 } },
    ],
  },
  agents: [{ slug: "intake", handoffs: [{ to_agent_slug: "billing", orchestration_config: { execution: "parallel", max_concurrency: 4 } }] }],
};
const disk = (body: Record<string, unknown>) => ({ package: body, sources: {}, findings: [], empty: false });
const branchFindings = (body: Record<string, unknown>, published = limits()) =>
  checkPackage(disk(body), { schema, limits: published }).filter((f) => f.code.startsWith("branch"));

describe("validate: branch concurrency", () => {
  it("a fan-out above the width is capped, one within it is fine, and a sequential loop runs no branches", () => {
    expect(branchFindings(pkg)).toEqual([
      expect.objectContaining({
        code: "branch_width_capped",
        severity: "warning",
        path: "registry_entities.graph_edges[0].config.max_concurrency",
        message: "The edge triage → legal sets max_concurrency 20, above this instance's branch width of 8 (ORCHESTRATION_MAX_BRANCH_CONCURRENCY): it runs at most 8 branches at once.",
      }),
    ]);
    expect(branchFindings(pkg)[0]!.hint).toMatch(/Nothing fails/);
  });

  it("with concurrent branches off, one warning names the fan-outs and the switch that is off", () => {
    const findings = branchFindings(pkg, limits(flagOff)).filter((f) => f.code === "branches_run_in_sequence");
    expect(findings).toEqual([expect.objectContaining({ severity: "warning", path: "registry_entities.graph_edges[0].config" })]);
    expect(findings[0]!.message).toBe(
      "This tenant runs fan-outs and Map loops in sequence, so the edge triage → legal, edge intake → billing run one branch after another (same result, slower): " +
        "feature_flags.ORCHESTRATION_PARALLEL_FANOUT_ENABLED is off (an operator turns it on in the Admin (Configure › Feature Flags), or with cavelon limits set orchestration_parallel_branches on --tenant <tenant> --confirm and a Platform-mode token).",
    );
  });

  it("a package without fan-outs or Map loops gets no warning, even with branches off", () => {
    expect(branchFindings({ registry_entities: { orchestration_nodes: [pkg.registry_entities.orchestration_nodes[0]] } }, limits(flagOff))).toEqual([]);
  });

  it("an instance that publishes no branch concurrency, or no limits, checks nothing", () => {
    const older = limits((values) => values.filter((v) => !v.key.startsWith("orchestration_max_branch") && !v.key.startsWith("orchestration_process") && v.key !== "orchestration_parallel_branches"));
    expect(branchFindings(pkg, older)).toEqual([]);
    expect(checkPackage(disk(pkg), { schema }).filter((f) => f.code.startsWith("branch"))).toEqual([]);
  });
});
