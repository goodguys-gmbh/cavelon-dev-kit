/**
 * Files that may belong to the customer (`AGENTS.md`, `.gitignore`, a
 * `CLAUDE.md`, a git hook, an agent's MCP configuration) get at most one block
 * between `cavelon:begin` and `cavelon:end` markers (plan 04, "Files the kit
 * writes"). The kit creates the file when it is missing, appends the block
 * once, and from then on changes only what is between the markers.
 */

export type CommentStyle = "html" | "hash";

const MARKERS: Record<CommentStyle, { begin: string; end: string }> = {
  html: { begin: "<!-- cavelon:begin -->", end: "<!-- cavelon:end -->" },
  hash: { begin: "# cavelon:begin", end: "# cavelon:end" },
};

/** A whole file the kit generated carries this token, so `init --update` may replace it. */
export const GENERATED_TOKEN = "cavelon:generated";

export type BlockOutcome = "created" | "appended" | "updated" | "unchanged" | "skipped";

export interface BlockResult {
  outcome: BlockOutcome;
  content?: string;
  /** Why a file was left alone. */
  reason?: string;
}

function lineEnding(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/** Where the block is: line indexes of the markers, or why it cannot be found safely. */
function locate(lines: string[], style: CommentStyle): { begin: number; end: number } | { error: string } | undefined {
  const { begin, end } = MARKERS[style];
  const begins = lines.flatMap((line, i) => (line.trim() === begin ? [i] : []));
  const ends = lines.flatMap((line, i) => (line.trim() === end ? [i] : []));
  if (begins.length === 0 && ends.length === 0) return undefined;
  if (begins.length !== 1 || ends.length !== 1 || ends[0]! < begins[0]!) {
    return { error: `its ${begin} … ${end} markers are not one well-formed pair` };
  }
  return { begin: begins[0]!, end: ends[0]! };
}

/**
 * The file's content with `body` between the markers.
 * `onlyExisting` leaves a file without a block alone (`init --update`).
 */
export function upsertBlock(
  existing: string | undefined,
  body: string,
  style: CommentStyle,
  options: { onlyExisting?: boolean; afterShebang?: boolean } = {},
): BlockResult {
  const { begin, end } = MARKERS[style];
  const bodyLines = body.trimEnd().split(/\r?\n/);
  if (existing === undefined) {
    if (options.onlyExisting) return { outcome: "skipped", reason: "the file does not exist" };
    return { outcome: "created", content: [begin, ...bodyLines, end].join("\n") + "\n" };
  }
  const eol = lineEnding(existing);
  const lines = existing.split(/\r?\n/);
  const found = locate(lines, style);
  if (found && "error" in found) return { outcome: "skipped", reason: found.error };
  if (!found) {
    if (options.onlyExisting) return { outcome: "skipped", reason: "it has no cavelon block" };
    if (options.afterShebang && lines[0]?.startsWith("#!")) {
      // A script: the block runs first, before anything that may exit early.
      return { outcome: "appended", content: [lines[0], begin, ...bodyLines, end, ...lines.slice(1)].join(eol) };
    }
    const trimmed = withoutTrailingNewlines(existing);
    const separator = trimmed ? eol + eol : "";
    return { outcome: "appended", content: trimmed + separator + [begin, ...bodyLines, end].join(eol) + eol };
  }
  const next = [...lines.slice(0, found.begin + 1), ...bodyLines, ...lines.slice(found.end)].join(eol);
  return next === existing ? { outcome: "unchanged" } : { outcome: "updated", content: next };
}

/**
 * The file's content without the block, as it was before `upsertBlock`
 * appended it: the markers, what is between them and the blank line that
 * separated the block from the rest go. `empty` when nothing else is left.
 */
export function removeBlock(existing: string | undefined, style: CommentStyle): BlockResult & { empty?: boolean } {
  if (existing === undefined) return { outcome: "unchanged" };
  const eol = lineEnding(existing);
  const lines = existing.split(/\r?\n/);
  const found = locate(lines, style);
  if (!found) return { outcome: "unchanged" };
  if ("error" in found) return { outcome: "skipped", reason: found.error };
  let begin = found.begin;
  if (begin > 0 && lines[begin - 1]!.trim() === "") begin--;
  const rest = [...lines.slice(0, begin), ...lines.slice(found.end + 1)];
  const content = rest.join(eol);
  if (!content.trim()) return { outcome: "updated", content: "", empty: true };
  return { outcome: "updated", content };
}

/** True when a whole file was written by the kit and may be replaced by it. */
export function isGenerated(content: string | undefined): boolean {
  return content !== undefined && content.includes(GENERATED_TOKEN);
}

/**
 * One entry of a JSON settings file (an agent's MCP configuration), set
 * without touching anything else. The file is rewritten only when doing so
 * reproduces every other byte of it; otherwise it is left alone and the
 * caller tells the person what to add.
 */
export function upsertJsonEntry(existing: string | undefined, keys: string[], value: unknown): BlockResult {
  if (existing === undefined || existing.trim() === "") {
    const root: Record<string, unknown> = {};
    setPath(root, keys, value);
    return { outcome: "created", content: JSON.stringify(root, null, 2) + "\n" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch {
    return { outcome: "skipped", reason: "it is not plain JSON (comments or a syntax error)" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { outcome: "skipped", reason: "it is not a JSON object" };
  }
  const indent = detectIndent(existing);
  const eol = lineEnding(existing);
  const serialize = (v: unknown) => {
    const text = JSON.stringify(v, null, indent).replace(/\n/g, eol);
    return /\r?\n$/.test(existing) ? text + eol : text;
  };
  if (serialize(parsed) !== existing) {
    return { outcome: "skipped", reason: "rewriting it would change its formatting" };
  }
  const current = getPath(parsed, keys);
  if (current !== undefined && JSON.stringify(current) === JSON.stringify(value)) return { outcome: "unchanged" };
  const parent = getPath(parsed, keys.slice(0, -1));
  if (parent !== undefined && (typeof parent !== "object" || parent === null || Array.isArray(parent))) {
    return { outcome: "skipped", reason: `its "${keys.slice(0, -1).join(".")}" is not an object` };
  }
  setPath(parsed as Record<string, unknown>, keys, value);
  return { outcome: current === undefined ? "appended" : "updated", content: serialize(parsed) };
}

/**
 * The JSON file without the entry at `keys`, when it holds exactly `value`.
 * Parents left empty go too, except the first `keep` keys (those the file had
 * before the kit added the entry); `empty` when the whole file is then `{}`.
 * Like `upsertJsonEntry`, the file is changed only when every other byte stays.
 */
export function removeJsonEntry(
  existing: string | undefined,
  keys: string[],
  matches: (value: unknown) => boolean,
  keep = 0,
): BlockResult & { empty?: boolean } {
  if (existing === undefined) return { outcome: "unchanged" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch {
    return { outcome: "skipped", reason: "it is not plain JSON (comments or a syntax error)" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { outcome: "skipped", reason: "it is not a JSON object" };
  const current = getPath(parsed, keys);
  if (current === undefined) return { outcome: "unchanged" };
  if (!matches(current)) return { outcome: "skipped", reason: `its "${keys.join(".")}" was changed since cavelon wrote it` };
  const indent = detectIndent(existing);
  const eol = lineEnding(existing);
  const serialize = (v: unknown) => {
    const text = JSON.stringify(v, null, indent).replace(/\n/g, eol);
    return /\r?\n$/.test(existing) ? text + eol : text;
  };
  if (serialize(parsed) !== existing) return { outcome: "skipped", reason: "rewriting it would change its formatting" };
  for (let depth = keys.length; depth > 0; depth--) {
    const parent = (depth === 1 ? parsed : getPath(parsed, keys.slice(0, depth - 1))) as Record<string, unknown>;
    const key = keys[depth - 1]!;
    if (depth < keys.length && (depth <= keep || Object.keys(parent[key] as object).length > 0)) break;
    delete parent[key];
  }
  return { outcome: "updated", content: serialize(parsed), empty: Object.keys(parsed).length === 0 };
}

function detectIndent(text: string): number | string {
  const match = /^\{\r?\n([ \t]+)"/.exec(text);
  if (!match) return 2;
  return match[1]!.includes("\t") ? "\t" : match[1]!.length;
}

function getPath(root: unknown, keys: string[]): unknown {
  let node = root;
  for (const key of keys) {
    if (!node || typeof node !== "object" || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

function setPath(root: Record<string, unknown>, keys: string[], value: unknown): void {
  let node = root;
  for (const key of keys.slice(0, -1)) {
    if (!node[key] || typeof node[key] !== "object") node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  node[keys[keys.length - 1]!] = value;
}


/** `text` without its trailing line breaks; a loop, not a regex anchored at the end. */
function withoutTrailingNewlines(text: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === "\n") end -= text[end - 2] === "\r" ? 2 : 1;
  return text.slice(0, end);
}
