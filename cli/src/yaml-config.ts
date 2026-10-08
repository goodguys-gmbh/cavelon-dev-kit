import { isDeepStrictEqual } from "node:util";
import { isAlias, isMap, isNode, isPair, isScalar, parseDocument, visit, type YAMLMap, type Pair } from "yaml";
import type { BlockResult } from "./markers.js";

function document(text: string): { doc: ReturnType<typeof parseDocument> } | { error: string } {
  const doc = parseDocument(text, { keepSourceTokens: true, uniqueKeys: true });
  if (doc.errors.length || doc.warnings.length) return { error: "it has a YAML syntax error or unsupported tag" };
  if (doc.contents !== null && !isMap(doc.contents)) return { error: "it is not a YAML mapping" };
  let ambiguous = false;
  visit(doc, (_key, node) => {
    if (isAlias(node) || (isNode(node) && (node.anchor || node.tag))) ambiguous = true;
    if (isPair(node) && (!isScalar(node.key) || typeof node.key.value !== "string" || node.key.value === "<<")) ambiguous = true;
  });
  if (ambiguous) return { error: "YAML aliases, anchors, tags, merge keys or complex keys require manual configuration" };
  return { doc };
}

function validPath(keys: string[]): boolean {
  return keys.length > 0 && keys.every(key => key.length > 0 && !["__proto__", "constructor", "prototype"].includes(key));
}

/** Read without normalizing the customer's YAML or resolving ambiguous indirection. */
export function readYamlEntry(text: string | undefined, keys: string[]): { value: unknown; kept: number } | { error: string } {
  if (!validPath(keys)) return { error: "the configuration entry path is invalid" };
  if (text === undefined) return { value: undefined, kept: 0 };
  const parsed = document(text);
  if ("error" in parsed) return parsed;
  if (parsed.doc.contents === null) return { value: undefined, kept: 0 };
  let map: unknown = parsed.doc.contents;
  let kept = 0;
  for (const key of keys) {
    if (!isMap(map)) return { error: `its "${keys.slice(0, kept).join(".")}" is not a mapping` };
    if (!map.has(key)) return { value: undefined, kept };
    const node = map.get(key, true);
    kept++;
    if (kept === keys.length) return { value: isNode(node) ? node.toJSON() : node, kept };
    map = node;
  }
  return { value: undefined, kept };
}

function hasComments(node: unknown): boolean {
  let found = false;
  visit(node as YAMLMap, (_key, child) => {
    if (isNode(child) && (child.comment || child.commentBefore)) found = true;
  });
  return found;
}

function editRange(text: string, start: number, end: number, content: string): BlockResult {
  const updated = text.slice(0, start) + content + text.slice(end);
  const checked = document(updated);
  if ("error" in checked) return { outcome: "skipped", reason: "this YAML cannot be edited safely; configure it manually" };
  const before = document(text);
  if ("error" in before) return { outcome: "skipped", reason: before.error };
  const comments = (doc: ReturnType<typeof parseDocument>) => {
    const found: string[] = [];
    for (const value of [doc.comment, doc.commentBefore]) if (typeof value === "string") found.push(value);
    visit(doc, (_key, node) => { if (isNode(node)) for (const value of [node.comment, node.commentBefore]) if (typeof value === "string") found.push(value); });
    return found.sort((left, right) => left.localeCompare(right));
  };
  if (!isDeepStrictEqual(comments(before.doc), comments(checked.doc))) return { outcome: "skipped", reason: "changing this entry would remove a personal comment; edit it manually" };
  return { outcome: "updated", content: updated };
}

function suffix(text: string, start: number, end: number): string {
  if (!text.slice(start, end).endsWith("\n")) return "";
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function lineStart(text: string, offset: number): number {
  const start = text.lastIndexOf("\n", offset - 1) + 1;
  return text.slice(start, offset).trim() ? offset : start;
}

function nestedValue(keys: string[], value: unknown): unknown {
  let nested = value;
  for (let index = keys.length - 1; index >= 0; index--) nested = { [keys[index]!]: nested };
  return nested;
}

function appendValue(existing: string, parent: YAMLMap, keys: string[], depth: number, value: unknown): BlockResult {
  if (!parent.range) return { outcome: "skipped", reason: "this YAML mapping cannot be edited safely" };
  const property = `${JSON.stringify(keys[depth])}: ${JSON.stringify(nestedValue(keys.slice(depth + 1), value))}`;
  let result: BlockResult;
  if (parent.flow) {
    const end = existing.lastIndexOf("}", parent.range[1] - 1);
    result = editRange(existing, end, end, `${parent.items.length ? ", " : ""}${property}`);
  } else {
    const firstKey = parent.items[0]?.key;
    const offset = isNode(firstKey) && firstKey.range ? firstKey.range[0] : parent.range[0];
    const indent = " ".repeat(offset - lineStart(existing, offset));
    const end = parent.range[1];
    const newline = existing.includes("\r\n") ? "\r\n" : "\n";
    const leading = end && !existing.slice(0, end).endsWith("\n") ? newline : "";
    result = editRange(existing, end, end, `${leading}${indent}${property}${newline}`);
  }
  return result.outcome === "updated" ? { ...result, outcome: "appended" } : result;
}

function updateValue(existing: string, node: unknown, value: unknown): BlockResult {
  if (!isNode(node) || !node.range || hasComments(node)) return { outcome: "skipped", reason: "changing this entry would remove a personal comment; edit it manually" };
  return editRange(existing, node.range[0], node.range[1], JSON.stringify(value) + suffix(existing, node.range[0], node.range[1]));
}

function appendToEmpty(existing: string, keys: string[], value: unknown): BlockResult {
  const newline = existing.includes("\r\n") ? "\r\n" : "\n";
  const leading = existing && !existing.endsWith("\n") ? newline : "";
  const result = editRange(existing, existing.length, existing.length, `${leading}${JSON.stringify(keys[0])}: ${JSON.stringify(nestedValue(keys.slice(1), value))}${newline}`);
  return result.outcome === "updated" ? { ...result, outcome: "appended" } : result;
}

/** Surgical value/entry edits retain all bytes outside the owned YAML entry. */
export function upsertYamlEntry(existing: string | undefined, keys: string[], value: unknown, options: { matches?: (current: unknown) => boolean; onlyExisting?: boolean } = {}): BlockResult {
  const current = readYamlEntry(existing, keys);
  if ("error" in current) return { outcome: "skipped", reason: current.error };
  if (isDeepStrictEqual(current.value, value)) return { outcome: "unchanged" };
  if (current.value === undefined && options.onlyExisting) return { outcome: "skipped", reason: "it has no Cavelon entry" };
  if (current.value !== undefined && !options.matches?.(current.value)) return { outcome: "skipped", reason: `its "${keys.join(".")}" is a personal or conflicting entry` };
  if (existing === undefined) return { outcome: "created", content: JSON.stringify(nestedValue(keys, value), null, 2) + "\n" };
  const parsed = document(existing);
  if ("error" in parsed) return { outcome: "skipped", reason: parsed.error };
  if (parsed.doc.contents === null) return appendToEmpty(existing, keys, value);
  if (current.value !== undefined) return updateValue(existing, parsed.doc.getIn(keys, true), value);
  const parent = current.kept ? parsed.doc.getIn(keys.slice(0, current.kept), true) : parsed.doc.contents;
  if (!isMap(parent)) return { outcome: "skipped", reason: "this YAML mapping cannot be edited safely" };
  return appendValue(existing, parent, keys, current.kept, value);
}

function removalParent(doc: ReturnType<typeof parseDocument>, keys: string[], keep: number) {
  let removing = keys;
  let parent = doc.getIn(removing.slice(0, -1), true);
  while (isMap(parent) && parent.items.length === 1 && removing.length - 1 > keep && !hasComments(parent)) {
    removing = removing.slice(0, -1);
    parent = doc.getIn(removing.slice(0, -1), true);
  }
  return { removing, parent };
}

function pairRanges(pair: Pair | undefined): { key: [number, number, number]; value: [number, number, number] } | undefined {
  if (!pair || !isNode(pair.key) || !pair.key.range || !isNode(pair.value) || !pair.value.range || pair.key.comment || hasComments(pair.value)) return undefined;
  return { key: pair.key.range, value: pair.value.range };
}

function removeFlowPair(existing: string, parent: YAMLMap, index: number, ranges: NonNullable<ReturnType<typeof pairRanges>>): BlockResult {
  let start = ranges.key[0];
  let end = ranges.value[1];
  if (index < parent.items.length - 1) {
    const comma = existing.indexOf(",", end);
    if (comma < 0 || comma >= parent.range![1]) return { outcome: "skipped", reason: "this YAML separator cannot be edited safely" };
    end = comma + 1;
  } else {
    start = existing.lastIndexOf(",", start);
    if (start < parent.range![0]) return { outcome: "skipped", reason: "this YAML separator cannot be edited safely" };
  }
  return editRange(existing, start, end, "");
}

function removePair(existing: string, parent: YAMLMap, key: string): BlockResult {
  if (!parent.range) return { outcome: "skipped", reason: "this YAML mapping cannot be edited safely" };
  const index = parent.items.findIndex(pair => isScalar(pair.key) && pair.key.value === key);
  const ranges = pairRanges(parent.items[index]);
  if (!ranges) return { outcome: "skipped", reason: "removing this entry would remove a personal comment; edit it manually" };
  if (parent.items.length === 1) return editRange(existing, parent.range[0], parent.range[1], "{}" + suffix(existing, parent.range[0], parent.range[1]));
  if (parent.flow) return removeFlowPair(existing, parent, index, ranges);
  return editRange(existing, lineStart(existing, ranges.key[0]), ranges.value[2], "");
}

function emptyDocument(text: string): boolean {
  const final = document(text);
  if ("error" in final) return false;
  const doc = final.doc;
  return isMap(doc.contents) && !doc.contents.items.length && !hasComments(doc.contents) && !doc.comment && !doc.commentBefore;
}

export function removeYamlEntry(existing: string | undefined, keys: string[], matches: (current: unknown) => boolean, keep = 0): BlockResult & { empty?: boolean } {
  const current = readYamlEntry(existing, keys);
  if ("error" in current) return { outcome: "skipped", reason: current.error };
  if (current.value === undefined || existing === undefined) return { outcome: "unchanged" };
  if (!matches(current.value)) return { outcome: "skipped", reason: `its "${keys.join(".")}" was changed since cavelon wrote it` };
  const parsed = document(existing);
  if ("error" in parsed) return { outcome: "skipped", reason: parsed.error };
  const { removing, parent } = removalParent(parsed.doc, keys, keep);
  if (!isMap(parent)) return { outcome: "skipped", reason: "this YAML mapping cannot be edited safely" };
  const result = removePair(existing, parent, removing.at(-1)!);
  return result.outcome === "updated" ? { ...result, empty: emptyDocument(result.content!) } : result;
}
