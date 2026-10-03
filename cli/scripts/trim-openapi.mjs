#!/usr/bin/env node
// Trims an instance's published OpenAPI to the operations the kit uses, for the
// contract snapshot in contracts/cavelon/openapi.json:
//
//   node scripts/trim-openapi.mjs <openapi.json from an instance> [output]
//
// The operations are listed in contracts/kit-operations.json. The output keeps
// those operations and the components they reference, nothing else, so a
// refresh never brings in a route the kit does not call. Prose descriptions are
// dropped too: they explain the server's implementation, and the kit reads only
// the shapes.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const METHODS = ["get", "put", "post", "delete", "patch", "head", "options", "trace"];

export function kitOperations() {
  const list = JSON.parse(readFileSync(path.join(root, "contracts", "kit-operations.json"), "utf8"));
  return list.operations.map((entry) => {
    const [method, route] = entry.split(" ");
    return { method: method.toLowerCase(), route };
  });
}

/** Every `#/components/<kind>/<name>` reference inside a value. */
function collectRefs(value, out) {
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, out);
  } else if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      if (key === "$ref" && typeof inner === "string" && inner.startsWith("#/components/")) out.add(inner);
      else collectRefs(inner, out);
    }
  }
}

/** A copy without prose: every `description` whose value is text. A property named `description` is an object and stays. */
function withoutProse(value) {
  if (Array.isArray(value)) return value.map(withoutProse);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    if (key === "description" && typeof inner === "string") continue;
    out[key] = withoutProse(inner);
  }
  return out;
}

/** Code-point order, the same on every machine and locale. */
function byCodePoint(a, b) {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** The listed operations, each path's methods in a fixed order and the paths sorted, so a refresh diffs cleanly. */
function pickOperations(doc, operations) {
  const missing = operations.filter(({ method, route }) => !doc.paths?.[route]?.[method]);
  if (missing.length) {
    const names = missing.map((o) => o.method.toUpperCase() + " " + o.route);
    throw new Error(`The OpenAPI does not publish: ${names.join(", ")}`);
  }
  const routes = [...new Set(operations.map((o) => o.route))].toSorted(byCodePoint);
  const paths = {};
  for (const route of routes) {
    const item = doc.paths[route];
    const listed = new Set(operations.filter((o) => o.route === route).map((o) => o.method));
    paths[route] = item.parameters ? { parameters: item.parameters } : {};
    for (const method of METHODS.filter((m) => listed.has(m))) paths[route][method] = item[method];
  }
  return paths;
}

/** Every component the paths reference, directly or through other components. */
function referencedComponents(doc, paths) {
  const keep = new Set();
  const pending = new Set();
  collectRefs(paths, pending);
  for (const ref of pending) {
    pending.delete(ref);
    if (keep.has(ref)) continue;
    keep.add(ref);
    const [, , kind, name] = ref.split("/");
    const target = doc.components?.[kind]?.[name];
    if (target === undefined) throw new Error(`Unresolved reference ${ref}`);
    collectRefs(target, pending);
  }
  return keep;
}

/** The components to keep, sorted by name; security schemes are named by `security`, not referenced, so all stay. */
function keptComponents(doc, keep) {
  const components = {};
  for (const [kind, entries] of Object.entries(doc.components ?? {})) {
    const names = Object.keys(entries)
      .filter((name) => kind === "securitySchemes" || keep.has(`#/components/${kind}/${name}`))
      .toSorted(byCodePoint);
    if (!names.length) continue;
    components[kind] = {};
    for (const name of names) components[kind][name] = entries[name];
  }
  return components;
}

export function trim(doc, operations) {
  const paths = pickOperations(doc, operations);
  const out = {
    openapi: doc.openapi,
    info: { title: "Cavelon API", version: doc.info?.version ?? "unknown" },
    paths: withoutProse(paths),
    components: withoutProse(keptComponents(doc, referencedComponents(doc, paths))),
  };
  if (doc.security) out.security = doc.security;
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, output = path.join(root, "contracts", "cavelon", "openapi.json")] = process.argv.slice(2);
  if (!input) {
    process.stderr.write("usage: node scripts/trim-openapi.mjs <openapi.json> [output]\n");
    process.exit(2);
  }
  const trimmed = trim(JSON.parse(readFileSync(input, "utf8")), kitOperations());
  writeFileSync(output, JSON.stringify(trimmed, null, 2) + "\n");
  const count = Object.values(trimmed.paths).reduce((n, item) => n + METHODS.filter((m) => item[m]).length, 0);
  process.stdout.write(`${output}: ${count} operations, ${Object.keys(trimmed.components.schemas ?? {}).length} schemas\n`);
}
