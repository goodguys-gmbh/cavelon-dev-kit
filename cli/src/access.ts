import type { ApiClient } from "./http.js";
import { readPrincipal, type MetaPrincipal, type OperationNeedingAPerson } from "./principal.js";
import { cavelonCommand } from "./printed.js";

/**
 * What a credential may do, as `/meta/principal` publishes it, so the kit
 * offers and suggests only that. Advice only: nothing is refused on it, the
 * instance decides, and where it does not say, the kit behaves as before.
 *
 * A recent instance publishes, for every kind of credential, the permissions
 * as its routes accept them (activation as `harnesses.activate`, which a
 * token carries only when issued with may_activate) and `needs_a_person`: the
 * operations those permissions would allow that a person still runs. An older
 * instance publishes `permissions` that hold for a person's token, except
 * activation (`token.may_activate` says that), and that do not hold for an
 * API key: its scopes are all that says something there, and the kit says
 * nothing up front.
 */

/** The permission the instance checks to activate a solution. */
export const ACTIVATE_PERMISSION = "harnesses.activate";

/** Any one of these permissions. */
type AnyOf = readonly string[];

/** The settings permissions that manage a tenant's secrets and its variables alike. */
const SETTINGS_VALUES: AnyOf = ["settings.secrets.manage", "settings.manage"];

/**
 * The permissions an operation the kit sends needs: each entry, a permission
 * or any one of a list, as the instance's roles name them. The instance
 * publishes them only in a refusal ("Missing one of permissions: …"), so these
 * are the ones it checks today: they decide only what the kit offers and
 * suggests, never what it sends; a refusal that names others wins.
 */
export const OPERATION_PERMISSIONS: Readonly<Record<string, ReadonlyArray<string | AnyOf>>> = {
  "POST /api/v1/agent-graph/import": ["agents.edit"],
  "POST /api/v1/harnesses": ["harnesses.manage"],
  "POST /api/v1/harnesses/{harness_id}/activate": ["harnesses.manage", ACTIVATE_PERMISSION],
  "POST /api/v1/harnesses/{harness_id}/clone": ["harnesses.manage"],
  "POST /api/v1/harnesses/{harness_id}/deactivate": ["harnesses.manage"],
  "POST /api/v1/harnesses/{harness_id}/default": ["harnesses.manage"],
  "POST /api/v1/knowledge-bases/{kb_id}/documents/upload": ["knowledge_bases.manage_documents"],
  "PATCH /api/v1/knowledge-bases/{kb_id}/documents/active": ["knowledge_bases.manage_documents"],
  "PATCH /api/v1/model-registry/{model_registry_id}": ["agents.manage_llm_config"],
  "POST /api/v1/test-suites/{suite_id}/runs": ["playground.use"],
  "POST /api/v1/triggers/{trigger_id}/run": ["triggers.manage"],
  "PUT /api/v1/triggers/{trigger_id}/execution-identity": ["settings.manage", "triggers.manage"],
  "POST /api/v1/triggers/runs/{run_id}/cancel": ["triggers.manage"],
  "POST /api/v1/triggers/runs/{run_id}/loops/{loop_id}/pause": ["triggers.manage"],
  "POST /api/v1/triggers/runs/{run_id}/loops/{loop_id}/resume": ["triggers.manage"],
  "POST /api/v1/sandboxes/{sandbox_id}/artifact-jobs": ["sandboxes.write"],
  "POST /api/v1/sandboxes/{sandbox_id}/refresh-workspace": ["sandboxes.manage"],
  "POST /api/v1/sandboxes/{sandbox_id}/validate": ["sandboxes.manage"],
  "POST /api/v1/database-connectors/connections/{connection_id}/test": [["database_connectors.test", "database_connectors.manage"]],
  "POST /api/v1/database-connectors/connections": ["database_connectors.manage"],
  "PATCH /api/v1/database-connectors/connections/{connection_id}": ["database_connectors.manage"],
  "DELETE /api/v1/database-connectors/connections/{connection_id}": ["database_connectors.manage"],
  "POST /api/v1/database-connectors/connections/{connection_id}/schema": ["database_connectors.manage"],
  "GET /api/v1/database-connectors/login-script": ["database_connectors.view"],
  "GET /api/v1/database-connectors/connections/{connection_id}/login-script": ["database_connectors.view"],
  "POST /api/v1/database-connectors/queries/{query_id}/test-run": [["database_connectors.test", "database_connectors.manage"]],
  "PUT /api/v1/variables/{name}": [SETTINGS_VALUES],
  "DELETE /api/v1/variables/{name}": [SETTINGS_VALUES],
  "PUT /api/v1/secrets/{name}": [SETTINGS_VALUES],
  "DELETE /api/v1/secrets/{name}": [SETTINGS_VALUES],
};

/** An entry of OPERATION_PERMISSIONS in words: "harnesses.manage", "settings.secrets.manage or settings.manage". */
function needWords(need: string | AnyOf): string {
  return typeof need === "string" ? need : anyOf(need);
}

/** What the instance tells about a credential's permissions, read once per principal. */
export interface CredentialAccess {
  kind: MetaPrincipal["kind"];
  /**
   * The permissions the routes accept from it where it acts; null where the
   * instance does not publish them for this kind of credential (an API key on
   * an older instance) or the credential acts in no tenant yet.
   */
  permissions: string[] | null;
  /** Whether the instance publishes what it accepts from every kind of credential, `needs_a_person` included. */
  complete: boolean;
  /** An API key's scopes; null for a person's token. */
  scopes: string[] | null;
  needsAPerson: OperationNeedingAPerson[];
  principal: MetaPrincipal;
}

export function accessOf(principal: MetaPrincipal | undefined): CredentialAccess | undefined {
  if (!principal) return undefined;
  const complete = Array.isArray(principal.needs_a_person);
  const acting = principal.mode === "tenant" || principal.mode === "platform";
  let permissions: string[] | null = null;
  if (principal.permissions && acting && (complete || principal.kind !== "api_key")) {
    permissions = [...principal.permissions];
    // An older instance's token: activation is no permission there, may_activate says it.
    if (!complete && principal.token?.may_activate && permissions.includes("harnesses.manage") && !permissions.includes(ACTIVATE_PERMISSION)) {
      permissions.push(ACTIVATE_PERMISSION);
    }
  }
  return {
    kind: principal.kind,
    permissions,
    complete,
    scopes: principal.api_key ? [...principal.api_key.scopes] : null,
    needsAPerson: principal.needs_a_person ?? [],
    principal,
  };
}

const principals = new WeakMap<ApiClient, Promise<MetaPrincipal | undefined>>();

/** The client's principal, asked once per client; undefined where the instance does not say or cannot be asked. */
export function principalOf(client: ApiClient): Promise<MetaPrincipal | undefined> {
  let read = principals.get(client);
  if (!read) {
    read = readPrincipal(client).catch(() => undefined);
    principals.set(client, read);
  }
  return read;
}

/** The client's credential access, asked once per client. */
export async function accessFor(client: ApiClient): Promise<CredentialAccess | undefined> {
  return accessOf(await principalOf(client));
}

/** Whether a concrete path (`/api/v1/harnesses/abc/activate`) is an OpenAPI path template's. */
export function pathMatches(template: string, path: string): boolean {
  const want = template.split("/");
  const got = path.split("?")[0]!.split("/");
  if (want.length !== got.length) return false;
  return want.every((part, i) => (part.startsWith("{") && part.endsWith("}") ? got[i] !== "" : part === got[i]));
}

/** The operation key (`METHOD /template`) a request's method and path match, from those the kit knows permissions for. */
export function knownOperation(method: string, path: string): string | undefined {
  const verb = method.toUpperCase();
  return Object.keys(OPERATION_PERMISSIONS).find((key) => {
    const [m, template] = key.split(" ");
    return m === verb && pathMatches(template!, path);
  });
}

/** Whether a credential may send an operation, and why not. */
export interface OperationAccess {
  /** False where the instance says it may not; null where it does not say. */
  allowed: boolean | null;
  /** What it needs that the credential does not hold, in words: each a permission, or "a or b". */
  missing?: string[];
  /** Where a person runs it, the instance's reason. */
  person?: string;
}

/**
 * Whether the credential may send `METHOD /template`: refused where the
 * instance lists it among those a person runs, or where the published
 * permissions hold none the operation needs; unknown otherwise.
 */
export function operationAccess(access: CredentialAccess | undefined, operation: string): OperationAccess {
  if (!access) return { allowed: null };
  const [method, template] = operation.split(" ");
  const person = access.needsAPerson.find((o) => o.method === method && (o.path === template || pathMatches(o.path, template!)));
  if (person) return { allowed: false, person: person.reason || "a person runs it" };
  const needs = OPERATION_PERMISSIONS[operation];
  if (!needs || !access.permissions) return { allowed: null };
  const held = (need: string | AnyOf) => (typeof need === "string" ? [need] : need).some((p) => access.permissions!.includes(p));
  const missing = needs.filter((need) => !held(need));
  return missing.length ? { allowed: false, missing: missing.map(needWords) } : { allowed: true };
}

/** Whether the credential may activate a solution: null where the instance does not say. */
export function mayActivate(access: CredentialAccess | undefined): boolean | null {
  if (!access) return null;
  const known = operationAccess(access, "POST /api/v1/harnesses/{harness_id}/activate").allowed;
  if (known !== null) return known;
  // An older instance: a token says it itself; a key's scopes do not.
  return access.principal.token ? access.principal.token.may_activate : null;
}

/** "a or b", for a hint. */
export function anyOf(permissions: readonly string[]): string {
  if (permissions.length <= 1) return permissions[0] ?? "a permission";
  return `${permissions.slice(0, -1).join(", ")} or ${permissions.at(-1)}`;
}

/** "a and b", for what an operation needs all of. */
export function allOf(needs: readonly string[]): string {
  if (needs.length <= 1) return needs[0] ?? "a permission";
  return `${needs.slice(0, -1).join(", ")} and ${needs.at(-1)}`;
}

/** The credential as a hint names it. */
export function credentialWords(access: CredentialAccess | undefined): string {
  if (!access) return "this credential";
  if (access.kind === "api_key") return access.principal.api_key ? `the API key "${access.principal.api_key.name}"` : "this API key";
  return access.principal.token ? `the token "${access.principal.token.name}"` : "this session";
}

/** Who acts instead, where this credential may not: a sentence for a hint. */
export function whoInstead(access: CredentialAccess | undefined, refused: OperationAccess): string {
  if (refused.person) return `A person does it, in the Admin or with their own token: the instance says ${JSON.stringify(refused.person)}.`;
  const needs = allOf(refused.missing ?? []);
  if (access?.kind === "api_key") {
    return `An API key's scopes grant its permissions, and this one's (${access.scopes?.join(", ") || "none"}) hold no ${needs}: a person with ${needs} does it, or a tenant administrator issues a key that may.`;
  }
  const ceiling = access?.principal.token?.ceiling_role;
  return `A person whose role holds ${needs} does it, in the Admin or with their own token${ceiling ? ` (this token acts at most as ${ceiling})` : ""}.`;
}

/** The permissions a refusal names ("Missing one of permissions: a, b", "Missing permission: a"); empty when it names none. */
export function permissionsNamed(message: string): string[] {
  const at = /permissions?:\s*([\w.]+(?:\s*,\s*[\w.]+)*)/i.exec(message);
  return at ? at[1]!.split(",").map((p) => p.trim()).filter(Boolean) : [];
}

/** The scope an API key's refusal names ("API key missing required scope: admin"); undefined when it names none. */
export function scopeNamed(message: string): string | undefined {
  return /missing required scope:\s*([\w.]+)/i.exec(message)?.[1];
}

/** What the credential of a refused request is, for the hint of a 403. */
export interface RefusedCredential {
  /** From the token's prefix, or the instance's answer. */
  kind?: MetaPrincipal["kind"];
  access?: CredentialAccess;
  method: string;
  /** The path the request went to. */
  path: string;
}

/**
 * The hint of a 403 the instance sent without one: what the credential lacks,
 * named from the refusal or, where it names nothing, from what the principal
 * publishes, and who does it instead. A key has scopes, a token a ceiling, so
 * the two hear different things.
 */
export function forbiddenHint(message: string, refused: RefusedCredential): { hint: string; details: Record<string, unknown> } {
  const { access } = refused;
  const kind = access?.kind ?? refused.kind;
  const whoami = `\`${cavelonCommand("whoami")}\` shows what it may do.`;
  const person = access?.needsAPerson.find((o) => o.method === refused.method.toUpperCase() && pathMatches(o.path, refused.path));
  if (person) {
    return {
      hint: `A person does this, not a token or an API key${person.reason ? ` (the instance says: ${person.reason})` : ""}: in the Admin, or as a session of their own.`,
      details: { credential: kind ?? null, needs_a_person: true, reason: person.reason || null },
    };
  }
  const named = permissionsNamed(message);
  const scope = scopeNamed(message);
  // What it lacks: as the refusal names it ("Missing permissions: a, b" all of them, "Missing one of permissions: a, b" any),
  // else as the published permissions and the kit's table say; "needs" where only the table says.
  let lacks: string | undefined;
  let needs: string | undefined;
  let permissions: string[] = named;
  if (named.length) lacks = /one of permissions/i.test(message) ? anyOf(named) : allOf(named);
  else if (!scope) {
    const operation = knownOperation(refused.method, refused.path);
    const known = operation ? operationAccess(access, operation) : undefined;
    if (known?.missing) lacks = allOf((permissions = known.missing));
    else if (operation && known?.allowed !== true) needs = allOf((permissions = OPERATION_PERMISSIONS[operation]!.map(needWords)));
    else permissions = [];
  }
  const details: Record<string, unknown> = { credential: kind ?? null, ...(permissions.length ? { permissions } : {}), ...(scope ? { scope } : {}) };
  if (kind === "api_key") {
    const scopes = access?.scopes;
    const held = scopes ? ` Its scopes: ${scopes.join(", ") || "none"}.` : "";
    const what = scope ? `lacks the scope ${scope}` : lacks ? `lacks a scope that grants ${lacks}` : needs ? `may lack a scope that grants ${needs}` : "lacks a scope that allows this, or is limited to other solutions";
    return {
      hint: `An API key acts only with what its scopes grant, and this one ${what}.${held} A tenant administrator issues a key that may (Settings → API keys), or a person does this with their own token. ${whoami}`,
      details,
    };
  }
  const token = access?.principal.token;
  if (token && !token.may_activate && (lacks ?? needs)?.includes(ACTIVATE_PERMISSION)) {
    return {
      hint: `The token was created without "may activate". A person activates in the Admin, or creates a token with "may activate" on /account/access-tokens. ${whoami}`,
      details,
    };
  }
  const capped = token?.ceiling_role ? ` A token acts with the lesser of its owner's role and its ceiling (${token.ceiling_role}).` : " A token acts at most with its ceiling role.";
  if (lacks || needs) {
    return {
      hint: `${lacks ? `This token's role in the tenant lacks ${lacks}.` : `This needs ${needs}.`}${capped} A person whose role holds it does this, in the Admin or with their own token. ${whoami}`,
      details,
    };
  }
  return { hint: `The token does not reach this. Check the tenant and the token's role.${capped} ${whoami}`, details };
}

/** Said where a hint would suggest activating, and the credential may not. */
export const ACTIVATOR = "a person who may activate does it, in the Admin (this credential may not)";

/** The activate command for a hint, or who activates where the credential may not. */
export function activationStep(may: boolean | null, command: string): string {
  return may === false ? ACTIVATOR : `\`${command}\``;
}
