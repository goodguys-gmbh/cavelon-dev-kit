import type { CatalogEntry, PackageSchema } from "./contracts.js";
import { locate, type Finding, type PackageOnDisk } from "./package-files.js";
import { branches } from "./package-references.js";

/**
 * A solution's `settings.attached_documents`: how long a chat turn waits for a
 * file it carries that is still being read. The instance reads it leniently and
 * never refuses it: only `false` turns the wait off, the seconds are clamped to
 * the bounds it publishes, and anything else means the platform default. So a
 * value it would ignore or clamp is a warning here, not a schema error, and
 * only where the published package schema describes the setting: an instance
 * that does not is not second-guessed.
 */

export const ATTACHED_IGNORED_CODE = "attached_documents_value_ignored";
export const ATTACHED_CLAMPED_CODE = "attached_documents_wait_clamped";
const SETTING = "attached_documents";
const UNTIL_READABLE = "wait_until_readable";
const SECONDS = "wait_seconds";
const ATTACHMENTS_DOCS = "/docs/concepts/attachments";

export const ATTACHED_DOCUMENTS_CODES: CatalogEntry[] = [
  {
    code: ATTACHED_IGNORED_CODE,
    area: "package",
    message: "A solution's settings.attached_documents holds a value the instance ignores; a chat turn then waits for its files as long as the platform default.",
    hint:
      "Write wait_until_readable as true or false (only false turns the wait off) and wait_seconds as a whole number of seconds, or remove the value to keep the platform default. " +
      "This setting is the solution's wait for a file a chat turn carries; the tenant's attached_documents context-source limit (how much of the files reaches the model) is a separate setting.",
    docs: ATTACHMENTS_DOCS,
  },
  {
    code: ATTACHED_CLAMPED_CODE,
    area: "package",
    message: "A solution's settings.attached_documents.wait_seconds is outside the bounds the instance publishes; it waits at the nearest bound instead.",
    hint: "Set wait_seconds within the bounds the finding names; `cavelon schema harnesses.settings` shows them.",
    docs: ATTACHMENTS_DOCS,
  },
];

const asObject = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const propertiesOf = (schema: PackageSchema, node: unknown) => {
  for (const branch of branches(schema, node)) {
    const properties = asObject(branch.properties);
    if (properties) return properties;
  }
  return undefined;
};

interface Described {
  fields: Set<string>;
  minimum?: number;
  maximum?: number;
}

/** What the published schema says of the setting; undefined where it does not describe it. */
function described(schema: PackageSchema): Described | undefined {
  const items = branches(schema, schema.properties?.harnesses).map((b) => b.items).find((i) => i !== undefined);
  const settings = propertiesOf(schema, items)?.settings;
  const setting = settings === undefined ? undefined : propertiesOf(schema, settings)?.[SETTING];
  const fields = setting === undefined ? undefined : propertiesOf(schema, setting);
  if (!fields) return undefined;
  const seconds = branches(schema, fields[SECONDS]).find((b) => b.type === "integer" || b.type === "number");
  return {
    fields: new Set(Object.keys(fields)),
    minimum: typeof seconds?.minimum === "number" ? seconds.minimum : undefined,
    maximum: typeof seconds?.maximum === "number" ? seconds.maximum : undefined,
  };
}

/** Whether a schema error lies in the setting, which `checkAttachedDocuments` reports as the instance reads it. */
export function inAttachedDocuments(schema: PackageSchema, pointer: string): boolean {
  const parts = pointer.split("/");
  return parts[1] === "harnesses" && parts[3] === "settings" && parts[4] === SETTING && described(schema) !== undefined;
}

/** The number the instance reads from wait_seconds, or undefined where it falls back to the platform default. */
function secondsOf(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  // The instance parses a decimal number; a hexadecimal or binary spelling is not one there.
  if (!text || /[xob]/i.test(text)) return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function checkAttachedDocuments(disk: PackageOnDisk, schema: PackageSchema): Finding[] {
  const known = described(schema);
  const harnesses = disk.package.harnesses;
  if (!known || !Array.isArray(harnesses)) return [];
  const findings: Finding[] = [];
  harnesses.forEach((raw: unknown, i) => {
    const harness = asObject(raw);
    const settings = asObject(harness?.settings);
    if (!settings || settings[SETTING] === undefined || settings[SETTING] === null) return;
    const name = typeof harness!.slug === "string" ? ` "${harness!.slug}"` : "";
    const at = `/harnesses/${i}/settings/${SETTING}`;
    const setting = asObject(settings[SETTING]);
    if (!setting) {
      findings.push({
        code: ATTACHED_IGNORED_CODE,
        severity: "warning",
        ...locate(disk, at),
        message: `The solution${name} sets ${SETTING} to ${JSON.stringify(settings[SETTING])}, not an object: the instance ignores it, and a chat turn waits for its files as long as the platform default.`,
      });
      return;
    }
    const until = setting[UNTIL_READABLE];
    if (known.fields.has(UNTIL_READABLE) && until !== undefined && until !== null && typeof until !== "boolean") {
      findings.push({
        code: ATTACHED_IGNORED_CODE,
        severity: "warning",
        ...locate(disk, `${at}/${UNTIL_READABLE}`),
        message: `${UNTIL_READABLE} is ${JSON.stringify(until)}, not true or false: only false turns the wait off, so a chat turn of the solution${name} still waits for its files.`,
      });
    }
    const given = setting[SECONDS];
    if (!known.fields.has(SECONDS) || given === undefined || given === null) return;
    const seconds = typeof given === "boolean" ? undefined : secondsOf(given);
    if (seconds === undefined) {
      findings.push({
        code: ATTACHED_IGNORED_CODE,
        severity: "warning",
        ...locate(disk, `${at}/${SECONDS}`),
        message: `${SECONDS} is ${JSON.stringify(given)}, not a number of seconds: the instance ignores it, and a chat turn of the solution${name} waits as long as the platform default.`,
      });
      return;
    }
    const bound = known.minimum !== undefined && seconds < known.minimum ? known.minimum : known.maximum !== undefined && seconds > known.maximum ? known.maximum : undefined;
    if (bound === undefined) return;
    const range = `${known.minimum ?? "…"}–${known.maximum ?? "…"}`;
    findings.push({
      code: ATTACHED_CLAMPED_CODE,
      severity: "warning",
      ...locate(disk, `${at}/${SECONDS}`),
      message: `${SECONDS} is ${JSON.stringify(given)}, outside ${range}: a chat turn of the solution${name} waits ${bound} seconds instead.`,
    });
  });
  return findings;
}
