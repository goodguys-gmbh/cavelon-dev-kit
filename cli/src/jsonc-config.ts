import { applyEdits, createScanner, findNodeAtLocation, modify, parseTree, SyntaxKind, type Edit, type Node, type ParseError } from "jsonc-parser";
import type { BlockResult } from "./markers.js";

type Parsed = { root: Node } | { error: string };

function document(text: string): Parsed {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { allowTrailingComma: true });
  if (errors.length || !root) return { error: "it has a JSONC syntax error" };
  if (root.type !== "object") return { error: "it is not a JSON object" };
  const duplicate = (node: Node): boolean => {
    if (node.type === "object") {
      const names = node.children?.map(property => property.children![0]!.value as string) ?? [];
      if (new Set(names).size !== names.length) return true;
    }
    return node.children?.some(duplicate) ?? false;
  };
  if (duplicate(root)) return { error: "it has duplicate keys, so its effective configuration is ambiguous" };
  return { root };
}

function valueOf(node: Node | undefined): unknown {
  if (!node) return undefined;
  if (node.type === "object") return Object.fromEntries((node.children ?? []).map(property => [property.children![0]!.value, valueOf(property.children![1])]));
  if (node.type === "array") return (node.children ?? []).map(valueOf);
  return node.value;
}

function comments(text: string): string[] {
  const scanner = createScanner(text);
  const found: string[] = [];
  for (let token = scanner.scan(); token !== SyntaxKind.EOF; token = scanner.scan()) {
    if (token === SyntaxKind.LineCommentTrivia || token === SyntaxKind.BlockCommentTrivia) {
      found.push(text.slice(scanner.getTokenOffset(), scanner.getTokenOffset() + scanner.getTokenLength()));
    }
  }
  return found;
}

function same(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => same(item, right[index]));
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && same((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

function validPath(keys: string[]): boolean {
  return keys.length > 0 && keys.every(key => key.length > 0 && !["__proto__", "constructor", "prototype"].includes(key));
}

/** Read the effective owned entry and the parent depth setup must preserve on removal. */
export function readJsoncEntry(text: string | undefined, keys: string[]): { value: unknown; kept: number } | { error: string } {
  if (!validPath(keys)) return { error: "the configuration entry path is invalid" };
  if (text === undefined) return { value: undefined, kept: 0 };
  const parsed = document(text);
  if ("error" in parsed) return parsed;
  let kept = 0;
  for (let depth = 1; depth <= keys.length; depth++) {
    const node = findNodeAtLocation(parsed.root, keys.slice(0, depth));
    if (!node) break;
    if (depth < keys.length && node.type !== "object") return { error: `its "${keys.slice(0, depth).join(".")}" is not an object` };
    kept = depth;
  }
  return { value: valueOf(findNodeAtLocation(parsed.root, keys)), kept };
}

function removalEdits(text: string, root: Node, keys: string[]): Edit[] {
  const parent = findNodeAtLocation(root, keys.slice(0, -1));
  const children = parent?.children ?? [];
  const index = children.findIndex(property => property.children?.[0]?.value === keys.at(-1));
  if (index < 0) return [];
  const property = children[index]!;
  const edits: Edit[] = [{ offset: property.offset, length: property.length, content: "" }];
  // Delete the property and one separator, leaving adjacent comments and trivia byte-for-byte.
  const scanner = createScanner(text, true);
  scanner.setPosition(property.offset + property.length);
  if (scanner.scan() === SyntaxKind.CommaToken) edits.push({ offset: scanner.getTokenOffset(), length: 1, content: "" });
  else if (index > 0) {
    const previous = children[index - 1]!;
    scanner.setPosition(previous.offset + previous.length);
    if (scanner.scan() !== SyntaxKind.CommaToken) throw new Error("Missing property separator.");
    edits.push({ offset: scanner.getTokenOffset(), length: 1, content: "" });
  }
  return edits;
}

function edit(text: string, keys: string[], value: unknown): BlockResult {
  try {
    const before = document(text);
    if ("error" in before) return { outcome: "skipped", reason: before.error };
    // Without formatting options, edits cannot reformat adjacent personal settings.
    const content = applyEdits(text, value === undefined ? removalEdits(text, before.root, keys) : modify(text, keys, value, {}));
    const parsed = document(content);
    if ("error" in parsed) return { outcome: "skipped", reason: parsed.error };
    if (!same(comments(text), comments(content))) return { outcome: "skipped", reason: "changing this entry would remove a personal comment; edit it manually" };
    return content === text ? { outcome: "unchanged" } : { outcome: "updated", content };
  } catch {
    return { outcome: "skipped", reason: "this configuration cannot be edited safely" };
  }
}

/** Replace only a recognized kit entry; a conflicting or personally edited entry stays. */
export function upsertJsoncEntry(
  existing: string | undefined,
  keys: string[],
  value: unknown,
  options: { matches?: (current: unknown) => boolean; onlyExisting?: boolean } = {},
): BlockResult {
  if (!validPath(keys)) return { outcome: "skipped", reason: "the configuration entry path is invalid" };
  if (existing === undefined) {
    if (options.onlyExisting) return { outcome: "skipped", reason: "the file does not exist" };
    let root: unknown = value;
    for (const key of [...keys].reverse()) root = { [key]: root };
    return { outcome: "created", content: JSON.stringify(root, null, 2) + "\n" };
  }
  const current = readJsoncEntry(existing, keys);
  if ("error" in current) return { outcome: "skipped", reason: current.error };
  if (same(current.value, value)) return { outcome: "unchanged" };
  if (current.value === undefined && options.onlyExisting) return { outcome: "skipped", reason: "it has no Cavelon entry" };
  if (current.value !== undefined && !options.matches?.(current.value)) return { outcome: "skipped", reason: `its "${keys.join(".")}" is a personal or conflicting entry` };
  const result = edit(existing, keys, value);
  return result.outcome === "updated" && current.value === undefined ? { ...result, outcome: "appended" } : result;
}

/** Keep pre-existing parents and all comments, including comments in an otherwise empty container. */
export function removeJsoncEntry(existing: string | undefined, keys: string[], matches: (value: unknown) => boolean, keep = 0): BlockResult & { empty?: boolean } {
  if (existing === undefined) return { outcome: "unchanged" };
  const current = readJsoncEntry(existing, keys);
  if ("error" in current) return { outcome: "skipped", reason: current.error };
  if (current.value === undefined) return { outcome: "unchanged" };
  if (!matches(current.value)) return { outcome: "skipped", reason: `its "${keys.join(".")}" was changed since cavelon wrote it` };
  const removed = edit(existing, keys, undefined);
  if (removed.outcome !== "updated") return removed;
  let content = removed.content!;
  for (let depth = keys.length - 1; depth > keep; depth--) {
    const parsed = document(content);
    if ("error" in parsed) break;
    const parent = findNodeAtLocation(parsed.root, keys.slice(0, depth));
    if (!parent || parent.type !== "object" || parent.children?.length || comments(content.slice(parent.offset, parent.offset + parent.length)).length) break;
    const trimmed = edit(content, keys.slice(0, depth), undefined);
    if (trimmed.outcome !== "updated") break;
    content = trimmed.content!;
  }
  const parsed = document(content);
  const empty = "root" in parsed && !parsed.root.children?.length && comments(content).length === 0;
  return { outcome: "updated", content, empty };
}
