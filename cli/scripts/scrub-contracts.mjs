#!/usr/bin/env node
// Cleans the /meta and docs snapshots in contracts/cavelon/ after a refresh:
//
//   node scripts/scrub-contracts.mjs [--rename <old name>=Cavelon ...]
//
// An instance's texts can carry its developers' notes: issue references such as
// "(#12)" and, in a rule's explanation, the reasoning behind the rule. The
// snapshots keep what a user reads (codes, messages, hints, docs) and drop the
// rest: issue references go, and a rule's explanation keeps its first
// paragraph. `--rename` replaces a product name the texts still carry. The
// tests read the shapes, so nothing they check changes.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../contracts/cavelon");

/** Removes "(#12)", "(#12, #34)" and "(#12/3)", with the space before them. */
function withoutIssueRefs(text) {
  return text.replace(/ ?\(#\d+[^)]{0,40}\)/g, "");
}

/** Pairs of [old, new] from `--rename old=new`. */
let renames = [];

export function scrubText(text) {
  let out = withoutIssueRefs(text);
  for (const [from, to] of renames) out = out.replaceAll(from, to);
  return out;
}

/** The first paragraph, on one line, without a leading "#12:" or "#12 (b):". */
function firstParagraph(text) {
  const first = text.split("\n\n")[0].replaceAll("\n", " ");
  const lead = /^#\d+(?: \(\w+\))?[:.] /.exec(first);
  return lead ? first.slice(lead[0].length) : first;
}

function scrubValue(value, key) {
  if (typeof value === "string") return scrubText(key === "explanation" ? firstParagraph(value) : value);
  if (Array.isArray(value)) return value.map((item) => scrubValue(item));
  if (value && typeof value === "object") {
    const out = {};
    for (const [inner, item] of Object.entries(value)) out[inner] = scrubValue(item, inner);
    return out;
  }
  return value;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { rename: { type: "string", multiple: true } } });
  renames = (values.rename ?? []).map((pair) => {
    const at = pair.indexOf("=");
    if (at < 1) throw new Error(`--rename takes <old>=<new>, not ${pair}`);
    return [pair.slice(0, at), pair.slice(at + 1)];
  });
  for (const name of readdirSync(dir).filter((f) => f.startsWith("meta-") && f.endsWith(".json"))) {
    const file = path.join(dir, name);
    writeFileSync(file, JSON.stringify(scrubValue(JSON.parse(readFileSync(file, "utf8"))), null, 2) + "\n");
  }
  for (const name of readdirSync(path.join(dir, "docs"))) {
    const file = path.join(dir, "docs", name);
    writeFileSync(file, scrubText(readFileSync(file, "utf8")));
  }
  process.stdout.write(`scrubbed ${dir}\n`);
}
