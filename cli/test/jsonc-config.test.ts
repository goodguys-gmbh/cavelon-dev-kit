import { expect, it } from "vitest";
import { readJsoncEntry, removeJsoncEntry, upsertJsoncEntry } from "../src/jsonc-config.js";
import { decodeMcpEntry, encodeMcpEntry, isKitMcpEntry } from "../src/mcp-entry.js";
import { mcpCommand } from "../src/agents.js";

const entry = { type: "local", command: ["cavelon", "mcp"] };
const keys = ["mcp", "cavelon"];
const owns = (value: unknown) => isKitMcpEntry(value, "command-array", { type: "local" });

it("adds the owned server while preserving JSONC comments and unrelated formatting", () => {
  const existing = '{\r\n\t// operator settings\r\n\t"mcp": { "other" : { "command": ["other"] }, },\r\n}\r\n';
  const result = upsertJsoncEntry(existing, ["mcp", "cavelon"], entry);
  expect(result.outcome).toBe("appended");
  expect(result.content).toContain('// operator settings\r\n');
  expect(result.content).toContain('"other" : { "command": ["other"] }');
  expect(result.content?.replaceAll("\r\n", "")).not.toContain("\n");
});

it("creates a new file, recognizes reruns irrespective of key order, and does not invent an entry during update", () => {
  const created = upsertJsoncEntry(undefined, keys, entry);
  expect(created.outcome).toBe("created");
  expect(readJsoncEntry(created.content, keys)).toMatchObject({ value: entry });
  expect(upsertJsoncEntry(created.content, keys, entry)).toEqual({ outcome: "unchanged" });
  const reordered = '{"mcp":{"cavelon":{"command":["cavelon","mcp"],"type":"local"}}}';
  expect(upsertJsoncEntry(reordered, keys, entry)).toEqual({ outcome: "unchanged" });
  expect(upsertJsoncEntry(undefined, keys, entry, { onlyExisting: true }).outcome).toBe("skipped");
  expect(upsertJsoncEntry('{"mcp":{}}', keys, entry, { onlyExisting: true }).outcome).toBe("skipped");
});

it("updates only a recognized owned entry and leaves every other byte intact", () => {
  const before = '{ /* retain */ "mcp" : {"cavelon":{"type":"local","command":["cavelon","mcp"]}}, "tail" : [ 1,  2 ] }';
  const next = encodeMcpEntry(mcpCommand("linux"), "command-array", { type: "local" });
  const changed = upsertJsoncEntry(before, keys, next, { matches: owns });
  expect(changed.outcome).toBe("updated");
  expect(changed.content).toBe(before.replace(JSON.stringify(entry), JSON.stringify(next)));
  expect(upsertJsoncEntry(before, keys, next).outcome).toBe("skipped");
});

it("removes the owned entry without reformatting the other server or surrounding settings", () => {
  const before = '{\r\n\t// keep\r\n\t"mcp": {"other" : { "command": ["other"] },"cavelon":'+JSON.stringify(entry)+'},\r\n\t"tail": [ 1,  2 ],\r\n}\r\n';
  const removed = removeJsoncEntry(before, keys, owns, 1);
  expect(removed.outcome).toBe("updated");
  expect(removed.content).toBe(before.replace(',"cavelon":'+JSON.stringify(entry), ''));
  expect(removed.empty).toBe(false);
  expect(removeJsoncEntry(removed.content, keys, owns).outcome).toBe("unchanged");
});

it("keeps pre-existing parent containers and removes only empty ones setup created", () => {
  const created = upsertJsoncEntry(undefined, keys, entry).content!;
  const clean = removeJsoncEntry(created, keys, owns);
  expect(clean.empty).toBe(true);
  expect(readJsoncEntry(clean.content, keys)).toEqual({ value: undefined, kept: 0 });
  const kept = removeJsoncEntry(created, keys, owns, 1);
  expect(readJsoncEntry(kept.content, keys)).toEqual({ value: undefined, kept: 1 });
});

it("never reports a commented root as an empty file that setup can delete", () => {
  const before = '// personal note\n{"mcp":{"cavelon":'+JSON.stringify(entry)+'}}';
  const removed = removeJsoncEntry(before, keys, owns);
  expect(removed.outcome).toBe("updated");
  expect(removed.content).toContain('// personal note');
  expect(removed.empty).toBe(false);
});

it("keeps an otherwise empty parent containing a personal comment", () => {
  const before = '{"mcp":{/* keep this container */"cavelon":'+JSON.stringify(entry)+'}}';
  const removed = removeJsoncEntry(before, keys, owns);
  expect(removed.outcome).toBe("updated");
  expect(removed.content).toContain('/* keep this container */');
  expect(readJsoncEntry(removed.content, keys)).toEqual({ value: undefined, kept: 1 });
});

it("refuses to destroy a comment inside an owned entry during replacement or removal", () => {
  const before = '{"mcp":{"cavelon":{"type":"local",/* person note */"command":["cavelon","mcp"]}}}';
  const next = encodeMcpEntry(mcpCommand("linux"), "command-array", { type: "local" });
  for (const result of [upsertJsoncEntry(before, keys, next, { matches: owns }), removeJsoncEntry(before, keys, owns)]) {
    expect(result.outcome).toBe("skipped");
    expect(result.reason).toMatch(/comment/);
    expect(result.content).toBeUndefined();
  }
});

it.each([
  '{"mcp":{"cavelon":{"type":"local","command":["custom","mcp"]}}}',
  '{"mcp":{"cavelon":{"type":"local","command":["cavelon","mcp"],"timeout":30}}}',
])("preserves a conflicting or personally extended entry", before => {
  expect(upsertJsoncEntry(before, keys, entry, { matches: owns }).outcome).toBe("skipped");
  expect(removeJsoncEntry(before, keys, owns).outcome).toBe("skipped");
});

it.each([
  '{"mcp":',
  '[{"mcp":{}}]',
  '{"mcp":{},"mcp":{}}',
  '{"other":{"x":1,"x":2},"mcp":{}}',
  '{"mcp":[1,2]}',
  '{"mcp":null}',
])("skips invalid or ambiguous documents for every lifecycle operation", before => {
  expect(readJsoncEntry(before, keys)).toHaveProperty("error");
  expect(upsertJsoncEntry(before, keys, entry).outcome).toBe("skipped");
  expect(removeJsoncEntry(before, keys, owns).outcome).toBe("skipped");
});

it("reads unrelated prototype-like property names without losing or reinterpreting their values", () => {
  const text = '{"__proto__":{"custom":true},"mcp":{"cavelon":'+JSON.stringify(entry)+'}}';
  expect(readJsoncEntry(text, keys)).toMatchObject({ value: entry });
  expect(upsertJsoncEntry(text, keys, entry)).toEqual({ outcome: "unchanged" });
  expect(({} as Record<string, unknown>).custom).toBeUndefined();
});

it.each([[], ["__proto__", "cavelon"], ["mcp", ""]].map(path => ({ path })))("refuses unsafe or empty edit paths", ({ path }) => {
  expect(readJsoncEntry("{}", path)).toHaveProperty("error");
  expect(upsertJsoncEntry(undefined, path, entry).outcome).toBe("skipped");
});

it.each([
  '/* before */"cavelon":'+JSON.stringify(entry)+',/* after */"other":{"command":["other"]}',
  '"other":{"command":["other"]},/* before */"cavelon":'+JSON.stringify(entry)+'/* after */',
  '"other":{"command":["other"]},/* before */"cavelon":'+JSON.stringify(entry)+',/* after */',
])("preserves comments around first, last and trailing-comma properties during removal", contents => {
  const removed = removeJsoncEntry('{"mcp":{'+contents+'}}', keys, owns, 1);
  expect(removed.outcome).toBe("updated");
  expect(removed.content).toContain('/* before */');
  expect(removed.content).toContain('/* after */');
  expect(readJsoncEntry(removed.content, ["mcp", "other"])).toMatchObject({ value: { command: ["other"] } });
});

it.each(["linux", "win32"] as const)("round-trips the %s command array and preserves platform-specific arguments", platform => {
  const command = mcpCommand(platform);
  const encoded = encodeMcpEntry(command, "command-array", { type: "local" });
  expect(encoded).toEqual({ type: "local", command: [command.command, ...command.args] });
  expect(decodeMcpEntry(encoded, "command-array")).toEqual(command);
  expect(isKitMcpEntry(encoded, "command-array", { type: "local" })).toBe(true);
  expect(isKitMcpEntry({ command: encoded.command, type: "local" }, "command-array", { type: "local" })).toBe(true);
  expect(isKitMcpEntry(encoded, "command-args", { type: "local" })).toBe(false);
});

it("recognizes installed command/args and array forms but never takes personal options", () => {
  expect(isKitMcpEntry(entry, "command-array", { type: "local" })).toBe(true);
  expect(encodeMcpEntry({ command: "cavelon", args: ["mcp"] }, "command-args")).toEqual({ command: "cavelon", args: ["mcp"] });
  expect(isKitMcpEntry({ args: ["mcp"], command: "cavelon" }, "command-args")).toBe(true);
  expect(decodeMcpEntry({ args: ["mcp"], command: "cavelon" }, "command-args")).toEqual({ command: "cavelon", args: ["mcp"] });
  expect(isKitMcpEntry({ ...entry, enabled: false }, "command-array", { type: "local" })).toBe(false);
  expect(isKitMcpEntry(["cavelon", "mcp"], "command-array")).toBe(false);
});

it.each([null, {}, { command: [] }, { command: ["cavelon", 1] }, { command: ["", "mcp"] }, { command: "cavelon", args: "mcp" }])("does not decode an invalid process command", value => {
  expect(decodeMcpEntry(value, "command-array")).toBeUndefined();
  expect(decodeMcpEntry(value, "command-args")).toBeUndefined();
});

it("keeps spaces and non-ASCII process arguments as individual words", () => {
  const command = { command: "C:\\Program Files\\Cavelon\\cavelon.exe", args: ["mcp", "directory with spaces", "München"] };
  expect(decodeMcpEntry(encodeMcpEntry(command, "command-array"), "command-array")).toEqual(command);
});
