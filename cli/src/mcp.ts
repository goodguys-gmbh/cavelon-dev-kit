import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { CommandSpec, Input } from "./command.js";
import { createContext, withWarnings } from "./context.js";
import { asCavelonError, usageError } from "./errors.js";
import type { Io } from "./io.js";
import { KIT_VERSION } from "./version.js";

/**
 * `cavelon mcp`: the workflow commands as coarse MCP tools over stdio, never
 * one tool per API operation. Each tool runs the command's own code, carries
 * its read-only or destructive annotation, and never blocks: work that takes
 * time returns an operation id, and `operation_status` reads it.
 */

const INSTRUCTIONS =
  "Tools for one Cavelon instance, acting with the token a person stored with `cavelon login` " +
  "(or CAVELON_TOKEN). You never see or pass the token. Tools that start work (kb_upload, test_run, " +
  "loop_start, sandbox_seed, artifacts_export) return operation ids at once; read them with operation_status, " +
  "and follow a loop with loop_iterations. What needs confirmation: apply imports only with confirm set to a preview's id; " +
  "limits_set, models_set_limit, loop_cancel, sandbox_seed, trigger_identity, and api for an operation that is not read-only, " +
  "return what they would do and change nothing without confirm: true; show the person that first. " +
  "init and pull write files in the solution folder without confirm (pull refuses to replace package files with uncommitted changes unless force), " +
  "and the other changing tools act at once. api refuses, even with confirm, an operation the instance marks for a person " +
  "(x-cavelon-person-only; its reason is in the error), or on an instance that marks none, one that changes a secret, " +
  "creates or revokes a credential (tokens, API keys, sign-in) or decides an approval. Tools read and write files only " +
  "inside the solution folder (the folder of cavelon.yaml, or the one the server started in), never in cavelon's own " +
  "config or cache directory. Read limits before planning a solution: it lists what the " +
  "instance allows this tenant (upload sizes and types, run and tool limits, timeouts, quotas) and who changes each. " +
  "Never change a limit on your own: propose the old and new value (limits_set for a limit a tenant admin changes, " +
  "models_set_limit for an endpoint's max_concurrent_requests) and let the person decide; an operator's limit goes to the operator. " +
  "variables_list/variables_get/variables_set handle plain-text {{var:…}} values. secrets_list shows which {{secret:…}} " +
  "values are set, never a value: a person sets a secret, so tell them the exact `cavelon secrets set <name>` command " +
  "to run in their terminal, and never ask for, read or pass a secret value. Never approve or decide an approval; " +
  "that stays with a person. Use docs_search before guessing, " +
  "and api_list/api_describe/api for anything without its own tool.";

type JsonSchema = Record<string, unknown>;

export function toolName(spec: CommandSpec): string | undefined {
  return spec.mcpTool || undefined;
}

/** A command with its own `tenant` argument (use_tenant) takes no tenant override. */
function ownsTenant(spec: CommandSpec): boolean {
  return Boolean(spec.positionals?.some((p) => p.name === "tenant") || spec.options?.tenant);
}

export function inputSchema(spec: CommandSpec): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const p of spec.positionals ?? []) {
    properties[p.name] = p.variadic
      ? { type: "array", items: { type: "string" }, description: p.description }
      : { type: "string", description: p.description };
    if (p.required) required.push(p.name);
  }
  for (const [name, option] of Object.entries(spec.options ?? {})) {
    if (option.cliOnly) continue;
    properties[name] =
      option.type === "boolean"
        ? { type: "boolean", description: option.description }
        : option.multiple
          ? { type: "array", items: { type: "string" }, description: option.description }
          : { type: ["string", "number"], description: option.description };
  }
  if (!ownsTenant(spec)) {
    properties.tenant = { type: "string", description: "Tenant slug or id, when not the one chosen for this directory." };
  }
  return { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false };
}

export function toolFor(spec: CommandSpec): Tool {
  const marked = spec.readOnly ? "Read-only." : spec.destructive ? "Changes the instance; may delete or overwrite." : "Changes the instance.";
  return {
    name: toolName(spec)!,
    description: [spec.summary, spec.description, marked].filter(Boolean).join("\n"),
    inputSchema: inputSchema(spec) as Tool["inputSchema"],
    annotations: {
      title: spec.summary,
      readOnlyHint: spec.readOnly,
      destructiveHint: !spec.readOnly && Boolean(spec.destructive),
      idempotentHint: Boolean(spec.idempotent),
      openWorldHint: true,
    },
  };
}

function inputFrom(spec: CommandSpec, args: Record<string, unknown>): Input {
  const input: Input = { positionals: {}, options: {} };
  for (const p of spec.positionals ?? []) {
    const value = args[p.name];
    if (value === undefined || value === null) continue;
    input.positionals[p.name] = p.variadic ? (Array.isArray(value) ? value.map(String) : [String(value)]) : String(value);
  }
  for (const [name, option] of Object.entries(spec.options ?? {})) {
    if (option.cliOnly) continue;
    const value = args[name];
    if (value === undefined || value === null) continue;
    if (option.type === "boolean") input.options[name] = value === true || value === "true";
    else if (option.multiple) input.options[name] = Array.isArray(value) ? value.map(String) : [String(value)];
    else input.options[name] = String(value);
  }
  return input;
}

function missingRequired(spec: CommandSpec, args: Record<string, unknown>): string[] {
  return (spec.positionals ?? []).filter((p) => p.required && (args[p.name] === undefined || args[p.name] === "")).map((p) => p.name);
}

/** Commands write nothing to stdout in MCP mode; stdout belongs to the protocol. */
function mcpIo(io: Io): Io {
  return { ...io, stdout: { write: () => true, isTTY: false } };
}

export function createMcpServer(io: Io, commands: CommandSpec[]): Server {
  const tools = commands.filter((c) => c.mcpTool);
  const byName = new Map(tools.map((c) => [toolName(c)!, c]));
  const server = new Server({ name: "cavelon", version: KIT_VERSION }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map(toolFor) }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const spec = byName.get(request.params.name);
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const fail = (error: unknown) => ({
      isError: true,
      content: [{ type: "text" as const, text: JSON.stringify({ error: asCavelonError(error).toJSON() }) }],
    });
    if (!spec) return fail(new Error(`Unknown tool ${request.params.name}.`));
    const missing = missingRequired(spec, args);
    if (missing.length) {
      return fail(usageError(`Missing ${missing.join(", ")}.`));
    }
    const tenant = !ownsTenant(spec) && typeof args.tenant === "string" ? args.tenant : undefined;
    const solutionEnv = spec.options?.env && typeof args.env === "string" ? args.env : undefined;
    const ctx = createContext(mcpIo(io), { json: true, tenant, solutionEnv }, "mcp");
    try {
      const result = await spec.run(ctx, inputFrom(spec, args));
      let data = result.data;
      if (data && typeof data === "object" && !Array.isArray(data)) {
        data = ctx.warnings.length ? withWarnings(data as Record<string, unknown>, ctx.warnings) : { ...(data as Record<string, unknown>) };
        if (result.exitCode) (data as Record<string, unknown>).exit_code = result.exitCode;
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(data ?? null) }] };
    } catch (error) {
      return fail(error);
    }
  });
  return server;
}
