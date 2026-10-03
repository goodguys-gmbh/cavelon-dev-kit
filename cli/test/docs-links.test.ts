import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The documentation links to itself and to the repository's files. A page
 * renamed or a heading reworded must not leave a reader at a dead link.
 */

const ROOT = path.resolve(__dirname, "../..");
const PAGES = [
  "README.md",
  "CONTRIBUTING.md",
  "AGENTS.md",
  "RELEASING.md",
  "SECURITY.md",
  "contracts/README.md",
  "examples/support-faq/README.md",
  ...readdirSync(path.join(ROOT, "docs"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => `docs/${f}`),
];

/** GitHub's anchor for a heading: lower case, punctuation dropped, spaces as dashes. */
function slug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^\p{L}\p{N} -]/gu, "")
    .replace(/ /g, "-");
}

function anchors(file: string): Set<string> {
  const text = readFileSync(file, "utf8").replace(/```[\s\S]*?```/g, "");
  const out = new Set<string>();
  for (const line of text.split("\n")) {
    const level = line.length - line.replace(/^#+/, "").length;
    if (level >= 1 && level <= 6 && line[level] === " ") out.add(slug(line.slice(level + 1).trim()));
  }
  return out;
}

describe("documentation links", () => {
  it("covers the pages the README links to", () => {
    const readme = readFileSync(path.join(ROOT, "README.md"), "utf8");
    for (const page of ["installation", "getting-started", "coding-agents", "concepts", "commands", "mcp", "limits", "troubleshooting", "security", "faq"]) {
      expect(readme, page).toContain(`(docs/${page}.md)`);
      expect(existsSync(path.join(ROOT, "docs", `${page}.md`)), page).toBe(true);
    }
  });

  it("point to files and headings that exist", () => {
    const broken: string[] = [];
    for (const page of PAGES) {
      const file = path.join(ROOT, page);
      const text = readFileSync(file, "utf8").replace(/```[\s\S]*?```/g, "");
      for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = match[1]!;
        if (/^[a-z]+:/i.test(target)) continue;
        const [rel, hash] = target.split("#") as [string, string | undefined];
        const resolved = rel ? path.resolve(path.dirname(file), rel) : file;
        if (!existsSync(resolved)) {
          broken.push(`${page}: ${target}`);
          continue;
        }
        if (hash && resolved.endsWith(".md") && !anchors(resolved).has(hash)) broken.push(`${page}: ${target} (no such heading)`);
      }
    }
    expect(broken).toEqual([]);
  });
});
