import { CavelonError, ExitCode } from "./errors.js";
import type { MetaPrincipal } from "./principal.js";
import { cavelonCommand } from "./printed.js";

/**
 * Who may set a tenant's secrets. The instance names the permissions only in
 * its refusal of `PUT /api/v1/secrets/{name}` ("Missing one of permissions:
 * …"); these are the ones it names today. They are advice only: `whoami`,
 * `activate` and `status` use them to say who sets a secret, and a refusal
 * that names none uses them; nothing is refused on them, so the instance
 * decides.
 */
export const SECRETS_PERMISSIONS = ["settings.secrets.manage", "settings.manage"];

/** Who sets a secret when this credential cannot, for a hint. */
export const SECRET_SETTER = "A tenant Owner (or another role allowed to manage secrets) sets it, in the Admin under Settings › Secrets or with their own token";

/**
 * Whether the credential may set the tenant's secrets: never a tenant API key;
 * a person's token when the permissions the instance publishes for it in the
 * tenant hold one of them. Null when the instance does not say (no
 * `/meta/principal`, no `permissions`, or no tenant to say it for).
 */
export function maySetSecrets(principal: MetaPrincipal | undefined): boolean | null {
  if (!principal) return null;
  if (principal.kind === "api_key") return false;
  if (!principal.permissions || principal.mode !== "tenant") return null;
  return SECRETS_PERMISSIONS.some((p) => principal.permissions!.includes(p));
}

/** The permissions a refusal names ("Missing one of permissions: a, b"); empty when it names none. */
export function permissionsNamed(message: string): string[] {
  const at = /permissions?:\s*([\w.]+(?:\s*,\s*[\w.]+)*)/i.exec(message);
  return at ? at[1]!.split(",").map((p) => p.trim()).filter(Boolean) : [];
}

/** What a person whose credential may not set it does: who sets it instead, and the command they run. */
export function secretSetterHint(name: string): string {
  return `${SECRET_SETTER}: \`${cavelonCommand("secrets", "set", name)}\`.`;
}

/** The instance's refusal of a credential that may not set or delete secrets, with who sets it instead. */
export function secretsPermissionMissing(verb: "set" | "delete", name: string, permissions: string[]): CavelonError {
  const needs = permissions.length ? permissions.join(" or ") : "a permission to manage secrets";
  return new CavelonError(ExitCode.unauthorized, {
    code: "permission_missing",
    status: 403,
    message: `This token's role may not ${verb} secrets: the instance refused it, as that needs ${needs}. Secret ${name} is unchanged.`,
    hint: secretSetterHint(name),
    details: { name, permissions, sent: true },
  });
}
