import { Type } from "typebox";
import { fileURLToPath } from "node:url";
import { nativeStdioClient, type NativeApprovalClient } from "./client.js";
import { assertNativeWorkspace, hasNativeProjectOwner, loadNativeRuntime, type NativeRuntime } from "./profile.js";
import { previewPages } from "./preview-pages.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export interface PiContext {
  cwd: string;
  hasUI: boolean;
  mode: string;
  isProjectTrusted(): boolean;
  ui: { confirm(title: string, message: string, options: { signal: AbortSignal; timeout: number }): Promise<unknown> };
}
export interface PiApi {
  on(event: "session_start" | "session_shutdown", callback: (event: unknown, ctx: PiContext) => Promise<void>): unknown;
  getAllTools(): Array<{ name: string }>;
  registerTool(tool: {
    name: string; label: string; description: string; parameters: ReturnType<typeof Type.Unsafe>; annotations: Tool["annotations"];
    executionMode: "sequential"; loadMode?: "essential"; mcpServerName?: string; mcpToolName?: string;
    execute(id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, update: unknown, ctx: PiContext): Promise<unknown>;
  }): void;
}

export function installPiExtension(pi: PiApi, options: NativeRuntime, clientName: "pi" | "omp" = "pi"): void {
  let opening: Promise<NativeApprovalClient> | undefined;
  let current: PiContext | undefined;
  let generation = 0;
  const owned = new Set<string>();
  const close = async () => {
    generation++;
    current = undefined;
    const previous = opening;
    opening = undefined;
    await (await previous?.catch(() => undefined))?.close();
  };
  const start = async (ctx: PiContext) => {
    if (options.scope === "project" && !ctx.isProjectTrusted()) {
      throw new Error("Cavelon project integration requires the person's trust for this project.");
    }
    await assertNativeWorkspace(options, ctx.cwd);
    const previous = opening;
    if (previous && (await previous).closed && opening === previous) opening = undefined;
    if (!opening) {
      const connection = nativeStdioClient({ ...options.command, cwd: ctx.cwd }, ctx.hasUI && ctx.mode === "tui", options.version);
      opening = connection;
      connection.catch(() => { if (opening === connection) opening = undefined; });
    }
    return opening;
  };
  pi.on("session_start", async (_event, ctx) => {
    await close();
    if (ctx.isProjectTrusted() && await hasNativeProjectOwner(options, clientName, ctx.cwd)) return;
    current = ctx;
    const epoch = generation;
    const client = await start(ctx);
    const tools = await client.tools();
    if (epoch !== generation) return;
    const existing = new Set(pi.getAllTools().map(tool => tool.name));
    if (tools.some(tool => existing.has(`mcp__cavelon__${tool.name}`) && !owned.has(`mcp__cavelon__${tool.name}`))) {
      await close();
      throw new Error("Cavelon tools already exist. Disable only the duplicate Cavelon MCP entry or replacement extension before loading native approval.");
    }
    for (const tool of tools) {
      const name = `mcp__cavelon__${tool.name}`;
      owned.add(name);
      pi.registerTool({
        name, label: tool.annotations?.title ?? tool.name, description: tool.description ?? tool.name,
        parameters: Type.Unsafe(tool.inputSchema), annotations: tool.annotations, executionMode: "sequential",
        ...(clientName === "omp" ? { loadMode: "essential" as const, mcpServerName: "cavelon", mcpToolName: tool.name } : {}),
        async execute(_id, params, signal, _update, ctx) {
          if (!current) throw new Error("The Cavelon native session has ended.");
          const callGeneration = generation;
          const result = await (await start(ctx)).call(tool.name, params, {
            signal,
            ask: ctx.hasUI && ctx.mode === "tui" ? async (message, dialogSignal, timeout) => {
              const pages = previewPages(message, process.stdout.columns || 80, process.stdout.rows || 24);
              if (pages.length > 1) for (let page = 0; page < pages.length; page++) {
                if (dialogSignal.aborted || callGeneration !== generation) return false;
                if (await ctx.ui.confirm(`Cavelon preview ${page + 1}/${pages.length}: continue`, pages[page]!, { signal: dialogSignal, timeout }) !== true) return false;
              }
              if (dialogSignal.aborted || callGeneration !== generation) return false;
              return ctx.ui.confirm("Cavelon: approve this exact change", pages.length === 1 ? message : `Approve the exact change shown in all ${pages.length} preview pages?`, { signal: dialogSignal, timeout });
            } : undefined,
          });
          return { content: result.content, details: { isError: result.isError === true },
            ...(clientName === "omp" ? { isError: result.isError === true } : {}) };
        },
      });
    }
  });
  pi.on("session_shutdown", close);
}

export default async function cavelon(pi: PiApi): Promise<void> {
  installPiExtension(pi, await loadNativeRuntime(fileURLToPath(new URL("./profile.json", import.meta.url)), "pi"));
}
