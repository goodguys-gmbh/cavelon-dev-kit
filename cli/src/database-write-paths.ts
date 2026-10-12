import type { ErrorCatalog, PackageSchema } from "./contracts.js";
import { queryTools, schemaKnowsWrites, type QueryBaseline } from "./database-queries.js";
import { locate, type Finding, type PackageOnDisk } from "./package-files.js";

type Json = Record<string, unknown>;
const object = (v: unknown): Json | undefined => v && typeof v === "object" && !Array.isArray(v) ? v as Json : undefined;
const rows = (v: unknown): Json[] => Array.isArray(v) ? v.filter(x => object(x)) as Json[] : [];
const active = (v: Json) => v.is_active !== false;
const scope = (v: Json, harness: unknown) => v.harness_slug === undefined || v.harness_slug === harness;
const CODE = "write_needs_confirmation";
export const WRITE_PATH_HINT = "Keep requires_confirmation on for chat. A direct Tool Call without it needs the latest Approval decision to be approved and no later agent stage; alternatively use a schedule, a webhook whose secret header is checked, or Run now. The instance checks the actual run and decision.";

/** Warn about visible outsider-started paths; topology cannot attest a runtime approval or webhook delivery. */
export function checkWritePaths(disk: PackageOnDisk, schema: PackageSchema, catalog: ErrorCatalog | null | undefined, baseline: QueryBaseline | undefined): Finding[] {
  if (!schemaKnowsWrites(schema) || !catalog?.api_error_codes?.some(e => e.code === CODE)) return [];
  const queries = new Map<string, Json>();
  for (const [slug, tool] of Object.entries(baseline?.tools ?? {})) {
    const query = object(tool.database_query);
    if (query) queries.set(slug, query);
  }
  for (const { slug, tool } of queryTools(disk.package)) {
    const query = object(tool.database_query);
    if (query) queries.set(slug, query);
  }
  for (const tool of rows(disk.package.tools)) if (tool.tool_type !== "database_query" && typeof tool.slug === "string") queries.delete(tool.slug);
  const unconfirmed = (slug: unknown) => typeof slug === "string" && queries.get(slug)?.kind === "write" && queries.get(slug)?.requires_confirmation === false;
  const registry = object(disk.package.registry_entities);
  const nodes = rows(registry?.orchestration_nodes);
  const agents = rows(disk.package.agents);
  const edges = rows(registry?.graph_edges);
  const triggers = rows(registry?.triggers);
  const skills = rows(disk.package.skills);
  const findings = new Map<string, Finding>();
  const warn = (pointer: string, message: string) => findings.set(pointer, { code: CODE, severity: "warning", ...locate(disk, pointer), message, hint: WRITE_PATH_HINT });
  const outsider = (trigger: Json) => trigger.trigger_type !== "schedule" && !(trigger.trigger_type === "webhook" && object(trigger.config)?.auth_mode === "secret_header");
  const harnesses = new Set([...nodes, ...agents, ...triggers].map(x => x.harness_slug));
  for (const harness of harnesses) {
    const localNodes = nodes.filter(n => active(n) && scope(n, harness));
    const localAgents = agents.filter(a => active(a) && scope(a, harness));
    const localEdges = edges.filter(e => active(e) && scope(e, harness));
    const localTriggers = triggers.filter(t => active(t) && scope(t, harness));
    type State = { kind: string; slug: string; approved: boolean };
    const pending: State[] = [];
    const add = (kind: string, slug: unknown, approved = false) => { if (typeof slug === "string") pending.push({ kind, slug, approved }); };
    for (const node of localNodes) {
      if (node.node_type === "chat_start") add("orchestration", node.slug);
      if (node.node_type === "trigger_start") {
        const trigger = localTriggers.find(t => t.slug === object(node.config)?.trigger_slug);
        if (trigger && outsider(trigger)) add("orchestration", node.slug);
      }
    }
    for (const trigger of localTriggers.filter(outsider)) add("agent", trigger.entrypoint_agent_slug);
    // An entrypoint agent is also a chat surface when no explicit Chat Start routes the conversation.
    if (!localNodes.some(n => n.node_type === "chat_start")) {
      for (const agent of localAgents.filter(a => a.is_entrypoint === true)) add("agent", agent.slug);
    }
    const seen = new Set<string>();
    while (pending.length) {
      const current = pending.pop()!;
      const key = JSON.stringify(current);
      if (seen.has(key)) continue;
      seen.add(key);
      const node = current.kind === "orchestration" ? localNodes.find(n => n.slug === current.slug) : undefined;
      const agent = current.kind === "agent" ? localAgents.find(a => a.slug === current.slug) : undefined;
      if (current.kind === "orchestration" && !node || current.kind === "agent" && !agent) continue;
      let approved = current.approved;
      if (agent) {
        approved = false;
        const assignments = [...rows(agent.tool_assignments), ...rows(agent.skill_assignments).filter(active).flatMap(a => rows(skills.find(s => s.slug === a.skill_slug)?.tool_assignments))].filter(active);
        for (const assignment of assignments.filter(a => unconfirmed(a.tool_slug))) {
          warn(`/agents/${agents.indexOf(agent)}/tool_assignments`, `Agent "${current.slug}" can call write query "${String(assignment.tool_slug)}" without confirmation on an outsider-started path; an agent cannot use the Approval-node exception, so the instance refuses it with ${CODE}.`);
        }
        for (const handoff of rows(agent.handoffs).filter(active)) add("agent", handoff.to_agent_slug, false);
      }
      if (node?.node_type === "approval") approved = true;
      if (node?.node_type === "tool_call" && unconfirmed(object(node.config)?.tool_slug) && !approved) {
        warn(`/registry_entities/orchestration_nodes/${nodes.indexOf(node)}/config/tool_slug`, `Tool Call node "${current.slug}" calls write query "${String(object(node.config)?.tool_slug)}" on an outsider-started path without an Approval node after the last agent stage; the instance refuses it with ${CODE}.`);
      }
      for (const edge of localEdges) {
        const from = object(edge.from_node_ref);
        const to = object(edge.to_node_ref);
        if (from?.kind !== current.kind || from.slug !== current.slug || typeof to?.kind !== "string") continue;
        const condition = object(object(edge.config)?.condition);
        const rejected = node?.node_type === "approval" && (object(edge.config)?.default === true || condition?.path === "approval.approved" && condition.operator === "equals" && condition.value === false);
        add(to.kind, to.slug, rejected ? false : approved);
      }
    }
  }
  return [...findings.values()];
}
