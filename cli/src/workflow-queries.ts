import type { PackageSchema } from "./contracts.js";
import type { TenantInventory } from "./commands/inventory.js";
import { parameterSchema, QUERY_TOOL_TYPE, queryTools, schemaKnowsQueries, type QueryBaseline } from "./database-queries.js";
import { locate, type Finding, type PackageOnDisk } from "./package-files.js";

export const WORKFLOW_QUERY_MISSING_CODE = "tool_call_database_query_missing";

type Json = Record<string, unknown>;
const object = (value: unknown): Json | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
const rows = (value: unknown): Json[] => Array.isArray(value) ? value.filter((row): row is Json => object(row) !== undefined) : [];
const pointerKey = (key: string) => key.replaceAll("~", "~0").replaceAll("/", "~1");
const scopeMatches = (row: Json, scope: unknown) => row.harness_slug === undefined || row.harness_slug === scope;
const active = (row: Json) => row.is_active !== false;

interface QueryNode {
  node: Json;
  index: number;
  config: Json;
  slug: string;
}

/** Node metadata is optional; a package's query tool also identifies the call. */
export function workflowQueryNodes(pkg: Json): QueryNode[] {
  const queries = new Set(queryTools(pkg).map((tool) => tool.slug));
  const nodes = object(pkg.registry_entities)?.orchestration_nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes.flatMap((raw, index) => {
    const node = object(raw);
    const config = object(node?.config);
    const slug = typeof config?.tool_slug === "string" ? config.tool_slug.trim() : undefined;
    return node?.node_type === "tool_call" && config && slug && (config.tool_type === QUERY_TOOL_TYPE || queries.has(slug))
      ? [{ node, index, config, slug }] : [];
  });
}

function resolve(schema: PackageSchema, raw: unknown): Json | undefined {
  let value = object(raw);
  for (let hops = 0; value && typeof value.$ref === "string" && hops < 10; hops++) {
    if (!value.$ref.startsWith("#/$defs/")) return undefined;
    value = object((schema.$defs as Json | undefined)?.[value.$ref.slice("#/$defs/".length)]);
  }
  return value;
}

/** Follow the published conditional config schema rather than a definition's name. */
export function schemaRunsQueryNodes(schema: PackageSchema): boolean {
  if (!schemaKnowsQueries(schema)) return false;
  const registry = resolve(schema, schema.properties?.registry_entities);
  const nodes = resolve(schema, object(registry?.properties)?.orchestration_nodes);
  const entry = resolve(schema, nodes?.items);
  for (const branch of rows(entry?.allOf)) {
    const types = object(object(object(branch.if)?.properties)?.node_type)?.enum;
    if (!Array.isArray(types) || !types.includes("tool_call")) continue;
    const config = resolve(schema, object(object(branch.then)?.properties)?.config);
    const allowed = object(object(config?.properties)?.tool_type)?.enum;
    return Array.isArray(allowed) && allowed.includes(QUERY_TOOL_TYPE);
  }
  return false;
}

/** Walk only the query's own solution and active edges; a disconnected trigger proves nothing. */
function triggerReaches(pkg: Json, query: QueryNode): boolean {
  if (!active(query.node)) return false;
  const registry = object(pkg.registry_entities);
  const scope = query.node.harness_slug;
  const nodes = rows(registry?.orchestration_nodes).filter((node) => scopeMatches(node, scope));
  const edges = rows(registry?.graph_edges).filter((edge) => active(edge) && scopeMatches(edge, scope));
  const triggers = rows(registry?.triggers).filter((trigger) => active(trigger) && scopeMatches(trigger, scope));
  const pending = [{ kind: "orchestration", slug: query.node.slug }];
  const seen = new Set<string>();
  while (pending.length) {
    const ref = pending.pop()!;
    const key = JSON.stringify([ref.kind, ref.slug]);
    if (seen.has(key)) continue;
    seen.add(key);
    if (ref.kind === "orchestration") {
      const node = nodes.find((node) => node.slug === ref.slug);
      if (node && !active(node)) continue;
      if (node?.node_type === "trigger_start") {
        const bound = object(node.config)?.trigger_slug;
        const trigger = rows(registry?.triggers).find((trigger) => trigger.slug === bound && scopeMatches(trigger, scope));
        if (!trigger || active(trigger)) return true;
      }
    } else if (ref.kind === "agent" && triggers.some((trigger) => trigger.entrypoint_agent_slug === ref.slug)) {
      return true;
    }
    for (const edge of edges) {
      const to = object(edge.to_node_ref);
      const from = object(edge.from_node_ref);
      if (to?.kind === ref.kind && to.slug === ref.slug && typeof from?.kind === "string" && typeof from.slug === "string") pending.push({ kind: from.kind, slug: from.slug });
    }
  }
  return false;
}

/** Statically visible argument names: declared input and a directly preceding flat Transform. */
function argumentNames(pkg: Json, query: QueryNode): Array<{ name: string; pointer: string }> {
  const found: Array<{ name: string; pointer: string }> = [];
  const input = object(query.config.input_schema);
  const properties = object(input?.properties) ?? {};
  const at = `/registry_entities/orchestration_nodes/${query.index}/config/input_schema`;
  for (const name of Object.keys(properties)) found.push({ name, pointer: `${at}/properties/${pointerKey(name)}` });
  if (Array.isArray(input?.required)) input.required.forEach((name, index) => {
    if (typeof name === "string" && !Object.hasOwn(properties, name)) found.push({ name, pointer: `${at}/required/${index}` });
  });
  const registry = object(pkg.registry_entities);
  const edges = rows(registry?.graph_edges).filter((edge) => active(edge) && scopeMatches(edge, query.node.harness_slug) && !object(edge.config)?.input_template);
  const nodes = Array.isArray(registry?.orchestration_nodes) ? registry.orchestration_nodes : [];
  nodes.forEach((raw, index) => {
    const node = object(raw);
    const config = object(node?.config);
    if (!node || !active(node) || !scopeMatches(node, query.node.harness_slug) || node.node_type !== "transform" || !config) return;
    if ((config.mode ?? "json_mapping") !== "json_mapping" || (config.target_mode ?? "flat") !== "flat") return;
    if (!edges.some((edge) => {
      const from = object(edge.from_node_ref);
      const to = object(edge.to_node_ref);
      return from?.kind === "orchestration" && from.slug === node.slug && to?.kind === "orchestration" && to.slug === query.node.slug;
    })) return;
    for (const name of Object.keys(object(config.mapping) ?? {})) found.push({ name, pointer: `/registry_entities/orchestration_nodes/${index}/config/mapping/${pointerKey(name)}` });
  });
  return found;
}

/** Schema checks still run separately; runtime alone checks dynamic payloads and identity. */
export function checkWorkflowQueries(disk: PackageOnDisk, schema: PackageSchema, inventory: TenantInventory | undefined, baseline: QueryBaseline | undefined): Finding[] {
  if (!schemaRunsQueryNodes(schema) || disk.unreadable?.includes("tools")) return [];
  const findings: Finding[] = [];
  const tools = queryTools(disk.package);
  const defaults = object(parameterSchema(schema)?.properties);
  const source = object(defaults?.source)?.default ?? "model";
  for (const queryNode of workflowQueryNodes(disk.package)) {
    const { node, index, slug } = queryNode;
    const at = `/registry_entities/orchestration_nodes/${index}/config/tool_slug`;
    const namedTool = rows(disk.package.tools).find((tool) => tool.slug === slug);
    // The selected tool decides its family; the node's metadata can be stale.
    if (namedTool && namedTool.tool_type !== QUERY_TOOL_TYPE) continue;
    const tool = tools.find((tool) => tool.slug === slug)?.tool;
    const query = object(tool?.database_query) ?? object(baseline?.tools[slug]?.database_query);
    if (!tool && !inventory?.names.tools?.includes(slug) && Array.isArray(inventory?.names.tools)) {
      findings.push({ code: WORKFLOW_QUERY_MISSING_CODE, severity: "warning", ...locate(disk, at), message: `Tool Call node "${String(node.slug ?? index)}" names database query "${slug}", which is neither in the package nor among the tenant's tools at the last pull (${inventory.written_at}); the import preview blocks it unless it exists by then.` });
    }
    if (!query) continue;
    const parameters = rows(query.parameters);
    const model = new Set(parameters.filter((parameter) => (parameter.source ?? source) === source).map((parameter) => parameter.name));
    const identity = new Set(parameters.filter((parameter) => (parameter.source ?? source) !== source).map((parameter) => parameter.name));
    for (const argument of argumentNames(disk.package, queryNode)) {
      if (model.has(argument.name)) continue;
      findings.push({
        code: "invalid_arguments", severity: "error", ...locate(disk, argument.pointer),
        message: `Tool Call node "${String(node.slug ?? index)}" passes "${argument.name}" to query "${slug}": ${identity.has(argument.name) ? "an identity parameter is filled by the instance from the signed-in Chat User" : "the query has no model-sourced parameter of that name"}; the call answers invalid_arguments and runs nothing.`,
        hint: "Use a Transform before the query node to emit only its model-sourced parameter names. Identity parameters come from the signed-in Chat User, never workflow data; the query's parameters decide the accepted arguments, not input_schema.",
      });
    }
    if ((identity.size || query.allows_anonymous !== true) && triggerReaches(disk.package, queryNode)) {
      findings.push({ code: "identity_required", severity: "warning", ...locate(disk, at), message: `Tool Call node "${String(node.slug ?? index)}" runs query "${slug}" in a workflow a trigger starts: the run has no signed-in Chat User, so ${identity.size ? "its identity parameters cannot be filled" : "the query does not allow anonymous calls"} and the call answers identity_required.`, hint: "Use this query in a conversation-bound run with a signed-in Chat User. A trigger can run a public-data query only when it has no identity parameters and allows_anonymous is true; a trigger execution identity is not a Chat User." });
    }
  }
  return findings;
}
