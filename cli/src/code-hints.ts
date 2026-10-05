import type { CatalogEntry } from "./contracts.js";

/**
 * What `cavelon explain` adds to a catalog entry: the codes closest to one it
 * does not know, and the command that does what an entry's fix asks of the
 * API.
 */

/** Edit distance between two strings, for codes of at most a few dozen characters. */
export function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
    }
    previous = current;
  }
  return previous[b.length]!;
}

const words = (code: string) => code.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** Words too common in codes to make two of them alike. */
const COMMON = new Set(["found", "invalid", "error", "missing", "required", "unknown", "unavailable", "failed", "denied", "limit", "reached", "exceeded", "allowed"]);

/**
 * The known codes closest to an unknown one: a few typos away first, then one
 * that contains it or that it contains, then one that starts with the same
 * words, then one that shares a telling word (five letters or more, not one
 * every other code has). A short or common word in the middle (`not`, `found`)
 * makes no two codes alike.
 */
export function similarCodes(code: string, known: string[], max = 8): string[] {
  const wanted = code.toLowerCase();
  const head = words(code);
  const threshold = Math.max(2, Math.floor(wanted.length / 4));
  const ranked: Array<{ code: string; rank: number }> = [];
  for (const candidate of new Set(known)) {
    const lower = candidate.toLowerCase();
    if (lower === wanted) continue;
    const distance = editDistance(wanted, lower);
    const theirs = words(candidate);
    const shared = head.findIndex((w, i) => theirs[i] !== w);
    const prefix = shared === -1 ? head.length : shared;
    let rank: number | undefined;
    if (distance <= threshold) rank = distance;
    // Containment counts only between codes of like length: `seed` inside `sandbox_seed_failed` says little.
    else if ((lower.includes(wanted) || wanted.includes(lower)) && Math.min(lower.length, wanted.length) * 2 >= Math.max(lower.length, wanted.length)) rank = 10;
    else if (prefix >= 2) rank = 20 - prefix;
    else if (prefix === 1 && head[0]!.length >= 4) rank = 30;
    else if (head.some((w) => w.length >= 5 && !COMMON.has(w) && theirs.includes(w))) rank = 40;
    if (rank !== undefined) ranked.push({ code: candidate, rank: rank * 100 + Math.min(distance, 99) });
  }
  return ranked.sort((a, b) => a.rank - b.rank || a.code.localeCompare(b.code, "en")).slice(0, max).map((r) => r.code);
}

/** The commands that do what a fix asks of a code directly. */
export const BY_CODE: Record<string, string> = {
  package_schema_invalid:
    "Run `cavelon validate`: it checks the package files against the package schema offline and names each field that " +
    "does not match, with file, line and path. `cavelon schema <section>` shows a section's fields and a minimal entry. " +
    "A missing manifest comes from `cavelon pull`, or `cavelon init` in the folder writes a minimal one.",
  package_requirements_changed: "Run `cavelon apply` again for a new preview, show it, and confirm its id with `cavelon apply --confirm <preview-id>`.",
  import_preview_stale: "Run `cavelon apply` again for a new preview, show it, and confirm its id with `cavelon apply --confirm <preview-id>`.",
};

/** The commands that stand for an API route a fix names. */
export const BY_ROUTE: Array<{ route: string; command: string }> = [
  { route: "/api/v1/meta/package-schema", command: "`cavelon schema` shows the package schema, `cavelon schema <section>` one section; `cavelon validate` checks the files against it." },
  { route: "/api/v1/meta/error-catalog", command: "`cavelon explain <code>` reads the error catalog." },
  { route: "/api/v1/meta/capabilities", command: "`cavelon status` and `cavelon limits` read the capabilities." },
  { route: "/api/v1/agent-graph/import/preview", command: "`cavelon apply` previews the package files." },
  { route: "/api/v1/agent-graph/import", command: "`cavelon apply --confirm <preview-id>` imports a preview." },
  { route: "/api/v1/agent-graph/export", command: "`cavelon pull` writes the export into the package files." },
  { route: "/readiness", command: "`cavelon status` shows the readiness; `cavelon activate` goes through it." },
  { route: "/api/v1/operations", command: "`cavelon wait <op_id>` and `cavelon status` read the operations." },
];

/**
 * The CLI's way to do what an entry's fix asks of the API, when there is
 * one: by code, else by the routes its hint and message name.
 */
export function cliFix(entry: Pick<CatalogEntry, "code" | "hint" | "message">): string | undefined {
  const direct = BY_CODE[entry.code];
  if (direct) return direct;
  const text = `${entry.hint ?? ""} ${entry.message}`;
  const found: string[] = [];
  for (const { route, command } of BY_ROUTE) {
    // The longer route of two that share a start is matched first; skip a shorter one inside it.
    if (text.includes(route) && !found.some((f) => f === command)) {
      const longer = BY_ROUTE.find((r) => r.route !== route && r.route.startsWith(route) && text.includes(r.route));
      if (!longer) found.push(command);
    }
  }
  return found.length ? found.join(" ") : undefined;
}
