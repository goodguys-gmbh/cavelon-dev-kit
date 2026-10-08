import { fileURLToPath } from "node:url";
import { startOpenCodeServer } from "./opencode-server.js";
import { loadNativeRuntime, nativeEntryHash, type NativeRuntime } from "./profile.js";

/** Kilo's released v1 tool contract matches the shared transport, not its profile. */
export async function startKiloServer(input: { directory: string }, options: NativeRuntime) {
  const server = await startOpenCodeServer(input, options, "kilo");
  let effective: { mcp?: Record<string, unknown> } | undefined;
  return {
    ...server,
    // Calling the SDK's config endpoint during plugin initialization re-enters
    // that initialization. Kilo supplies the merged config through this hook.
    async config(config: { mcp?: Record<string, unknown> }) { effective = config; },
    tool: Object.fromEntries(Object.entries(server.tool).map(([name, tool]) => [name, {
      ...tool,
      async execute(...args: Parameters<typeof tool.execute>) {
        const entry = effective?.mcp?.cavelon;
        if (options.entryHash && (!entry || nativeEntryHash(entry) !== options.entryHash)) {
          throw new Error("Kilo's effective Cavelon configuration differs from the owned entry; review its project, environment and managed policies before using the tools.");
        }
        return tool.execute(...args);
      },
    }])),
    async "shell.env"(_input: unknown, output: { env: Record<string, string> }) {
      output.env.CAVELON_AGENT = "1";
    },
  };
}

export default {
  id: "cavelon.native-approval.kilo",
  async server(input: { directory: string }, options: { profile?: unknown } | undefined) {
    const profile = options?.profile === undefined ? fileURLToPath(new URL("./profile.json", import.meta.url)) : options.profile;
    if (typeof profile !== "string") throw new Error("Cavelon native approval needs its setup profile.");
    return startKiloServer(input, await loadNativeRuntime(profile, "kilo"));
  },
};
