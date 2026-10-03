import type { Context } from "./command.js";
import { Contracts } from "./contracts.js";
import { ApiClient } from "./http.js";
import { colorEnabled, styleFor, type Io } from "./io.js";
import { requireInstance, requireToken, resolveSession, resolveTenantId, type GlobalOptions, type Session } from "./session.js";
import { detectShell, useShell } from "./shell.js";

export function createContext(io: Io, globals: GlobalOptions, mode: "cli" | "mcp" = "cli"): Context {
  const warnings: string[] = [];
  // Printed commands are quoted for the shell this one runs in.
  useShell(detectShell(io.env));
  let sessionPromise: Promise<Session> | undefined;
  let clientPromise: Promise<ApiClient> | undefined;
  let contractsPromise: Promise<Contracts> | undefined;

  const ctx: Context = {
    io,
    json: globals.json,
    style: styleFor(colorEnabled(io, globals.json)),
    globals,
    mode,
    warnings,
    warn(message) {
      if (!warnings.includes(message)) warnings.push(message);
    },
    session() {
      sessionPromise ??= resolveSession(io.env, io.cwd, globals);
      return sessionPromise;
    },
    async client(options = {}) {
      if (options.tenant === false) {
        const session = await ctx.session();
        return new ApiClient({ url: requireInstance(session), token: requireToken(session) }, io.env);
      }
      clientPromise ??= (async () => {
        const session = await ctx.session();
        const client = new ApiClient({ url: requireInstance(session), token: requireToken(session) }, io.env);
        client.target.tenantId = await resolveTenantId(io.env, session, client);
        return client;
      })();
      return clientPromise;
    },
    async optionalClient() {
      const session = await ctx.session();
      if (session.token) return ctx.client();
      return new ApiClient({ url: requireInstance(session) }, io.env);
    },
    contracts() {
      contractsPromise ??= (async () => new Contracts(await ctx.optionalClient(), io.env, io.now))();
      return contractsPromise;
    },
  };
  return ctx;
}
