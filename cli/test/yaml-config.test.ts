import { expect, it } from "vitest";
import { parse } from "yaml";
import { readYamlEntry, removeYamlEntry, upsertYamlEntry } from "../src/yaml-config.js";

const keys = ["extensions", "cavelon"];
const entry = { type: "stdio", name: "cavelon", enabled: true, cmd: "cavelon", args: ["mcp"] };
const matches = (value: unknown) => JSON.stringify(value) === JSON.stringify(entry);

it.each([
  "# personal header\nmode: 'auto' # keep\nextensions:\n  other: {cmd: other, args: []}\n# tail\n",
  "mode: auto\nextensions: {other: {cmd: other}} # keep\n",
  "# header\nmode: auto\n",
  "# header only\n",
  "mode: auto\nextensions: {}\n",
  "# header\r\nmode: auto\r\nextensions:\r\n  other: {cmd: other}\r\n",
  "prompt: |\n  Keep these personal instructions.\nextensions: {other: {cmd: 'other,with,commas'}}\n",
])("adds and removes only the owned entry while preserving unrelated bytes: %s", before => {
  const added = upsertYamlEntry(before, keys, entry);
  expect(added.outcome).toBe("appended");
  expect(readYamlEntry(added.content, keys)).toHaveProperty("value", entry);
  expect(parse(added.content!).mode).toBe(parse(before)?.mode);
  const kept = readYamlEntry(before, keys);
  expect(kept).not.toHaveProperty("error");
  const removed = removeYamlEntry(added.content, keys, matches, "kept" in kept ? kept.kept : 0);
  expect(removed.outcome).toBe("updated");
  expect(parse(removed.content!)).toEqual(parse(before) ?? {});
  for (const line of before.split("\n").filter(line => line && !line.startsWith("extensions:"))) expect(removed.content).toContain(line);
});

it("creates a removable YAML file with the platform-aware command", () => {
  const added = upsertYamlEntry(undefined, keys, entry);
  expect(added.outcome).toBe("created");
  expect(removeYamlEntry(added.content, keys, matches)).toMatchObject({ outcome: "updated", empty: true });
});

it("updates an owned block value without normalizing adjacent YAML", () => {
  const before = "# header\nmode: 'auto' # keep\nextensions:\n  cavelon:\n    type: stdio\n    name: cavelon\n    enabled: true\n    cmd: cavelon\n    args: [mcp]\n  other: {cmd: other} # keep other\n";
  const changed = { ...entry, cmd: "cmd", args: ["/c", "npx", "mcp"] };
  const result = upsertYamlEntry(before, keys, changed, { matches });
  expect(result.outcome).toBe("updated");
  expect(result.content).toContain("mode: 'auto' # keep");
  expect(result.content).toContain("  other: {cmd: other} # keep other\n");
  expect(readYamlEntry(result.content, keys)).toHaveProperty("value", changed);
});

it.each([
  "extensions: []\n",
  "extensions: {}\nextensions: {}\n",
  "extensions: {cavelon: {cmd: one, cmd: two}}\n",
  "settings: &settings {}\nextensions: *settings\n",
  "extensions: {<<: {cavelon: {cmd: other}}}\n",
  "extensions: !custom {}\n",
  "[wrong-root]\n",
  "extensions: {}\n---\nmode: auto\n",
])("refuses ambiguous or invalid YAML without changing it: %s", before => {
  expect(upsertYamlEntry(before, keys, entry).outcome).toBe("skipped");
});

it("preserves a personal entry, including a kit command with personal options", () => {
  const before = "extensions: {cavelon: {type: stdio, name: cavelon, enabled: false, cmd: cavelon, args: [mcp]}}\n";
  expect(upsertYamlEntry(before, keys, entry, { matches }).outcome).toBe("skipped");
  expect(removeYamlEntry(before, keys, matches).outcome).toBe("skipped");
});

it("keeps comments inside an otherwise owned entry", () => {
  const before = "extensions:\n  cavelon:\n    type: stdio\n    name: cavelon\n    enabled: true\n    cmd: cavelon # person note\n    args: [mcp]\n";
  expect(upsertYamlEntry(before, keys, entry, { matches }).outcome).toBe("unchanged");
  expect(upsertYamlEntry(before, keys, { ...entry, cmd: "new" }, { matches }).outcome).toBe("skipped");
  expect(removeYamlEntry(before, keys, matches).outcome).toBe("skipped");
});
