import { z } from "zod";
import { fileURLToPath } from "node:url";
import { nativeStdioClient, type NativeApprovalClient } from "./client.js";
import { callUi, NativeUiUnavailable } from "./ipc.js";
import { assertNativeWorkspace, loadNativeRuntime, type NativeRuntime } from "./profile.js";
import { PERSON_WAIT_MS } from "../approval-policy.js";

interface ToolContext { sessionID: string; abort: AbortSignal }

function toolArguments(input: Parameters<typeof z.fromJSONSchema>[0]) {
  const schema = z.fromJSONSchema(input);
  if (!(schema instanceof z.ZodObject)) throw new Error("A Cavelon tool must declare an object input schema.");
  return schema.shape;
}

export async function startOpenCodeServer(input: { directory: string }, options: NativeRuntime) {
  await assertNativeWorkspace(options, input.directory);
  const command = { ...options.command, cwd: input.directory };
  const discovery = await nativeStdioClient(command, false, options.version);
  const tools = await discovery.tools().finally(() => discovery.close());
  let fallback: Promise<NativeApprovalClient> | undefined;
  let disposed = false;
  const headless = async () => {
    if (disposed) throw new Error("Cavelon adapter closed.");
    const previous = fallback;
    if (previous && (await previous).closed && fallback === previous) fallback = undefined;
    if (!fallback) {
      const opening = nativeStdioClient(command, false, options.version);
      fallback = opening;
      opening.catch(() => { if (fallback === opening) fallback = undefined; });
    }
    return fallback;
  };
  const dispose = async () => {
    disposed = true;
    await (await fallback?.catch(() => undefined))?.close();
  };
  return {
    dispose,
    tool: Object.fromEntries(tools.map(tool => [`cavelon_${tool.name}`, {
      description: tool.description ?? tool.name,
      args: toolArguments(tool.inputSchema as Parameters<typeof z.fromJSONSchema>[0]),
      async execute(args: Record<string, unknown>, context: ToolContext) {
        if (disposed) throw new Error("Cavelon adapter closed.");
        try {
          const result = await callUi(options.runtimeDir, context.sessionID, tool.name, args, context.abort, (options.waitMs ?? PERSON_WAIT_MS) + 15_000);
          return { output: JSON.stringify(result), metadata: { isError: (result as { isError?: boolean }).isError === true } };
        } catch (error) {
          if (error instanceof NativeUiUnavailable) {
            const result = await (await headless()).call(tool.name, args, { signal: context.abort });
            return { output: JSON.stringify(result), metadata: { isError: result.isError === true } };
          }
          // Never dispatch a second change when the native call's outcome is unknown.
          return { output: JSON.stringify({ error: {
            code: "native_ui_disconnected", message: "The native UI call failed. Inspect the instance before repeating this change.",
            outcome_unknown: true, automatic_retry: false,
          } }), metadata: { isError: true } };
        }
      },
    }])),
  };
}

export default {
  id: "cavelon.native-approval",
  async server(input: { directory: string }, options: { profile?: unknown } | undefined) {
    const profile = options?.profile === undefined ? fileURLToPath(new URL("./profile.json", import.meta.url)) : options.profile;
    if (typeof profile !== "string") throw new Error("Cavelon native approval needs its setup profile.");
    return startOpenCodeServer(input, await loadNativeRuntime(profile, "opencode"));
  },
};
