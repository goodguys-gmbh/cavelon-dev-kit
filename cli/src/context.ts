import { checkKeyTenant } from "./acting.js";
import type { Context } from "./command.js";
import { Contracts } from "./contracts.js";
import { changeConfirmer } from "./change-confirmation.js";
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
        client.confirmer = changeConfirmer(ctx, client);
        client.target.tenantId =
          session.tokenKind === "api_key" ? await checkKeyTenant(client, session, (m) => ctx.warn(m)) : await resolveTenantId(io.env, session, client, io.now());
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

/** A warning as `validate --json` lists it; `code` is null for one about the run rather than the package. */
export interface WarningEntry {
  code: string | null;
  message: string;
}

/**
 * A command that reports warnings of its own keeps them; the context's are
 * added after, in the same form as the command's own entries (messages, or
 * `{code, message}` objects), so `warnings` keeps one shape whether or not a
 * context warning fires.
 */
export function withWarnings(data: Record<string, unknown>, warnings: string[]): Record<string, unknown> {
  const own = Array.isArray(data.warnings) ? (data.warnings as unknown[]) : [];
  const messageOf = (entry: unknown) => (entry && typeof entry === "object" ? (entry as { message?: unknown }).message : entry);
  const seen = new Set(own.map(messageOf));
  const objects = own.some((entry) => entry && typeof entry === "object");
  const added = warnings.filter((w) => !seen.has(w)).map((message): unknown => (objects ? ({ code: null, message } satisfies WarningEntry) : message));
  return { ...data, warnings: [...own, ...added] };
}
