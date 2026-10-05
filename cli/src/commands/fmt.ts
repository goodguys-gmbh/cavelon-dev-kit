import path from "node:path";
import { Lexer } from "yaml";
import { boolOption, type CommandSpec } from "../command.js";
import { CavelonError, ExitCode } from "../errors.js";
import { readTextFile, writeFileAtomic } from "../fsutil.js";
import { uncommitted } from "../git.js";
import { fileDigest, fileDigests, readPulledFiles, rememberAppliedFiles } from "../local-state.js";
import { packageVersionOf } from "../package-check.js";
import { canonical, contentPath, readPackage } from "../package-files.js";
import { exportForm, sectionContent, toYaml } from "../package-format.js";
import { requireInstance } from "../session.js";
import { requireSolution, schemaFor } from "./solution.js";

/**
 * `cavelon fmt`: hand-written package files in the form the instance's export
 * gives them, worked out offline from the package schema. Pull keeps a file's
 * bytes while its value is the export's, so once the defaults the export
 * fills in are in the files, the first pull after an apply rewrites only what
 * changed on the instance.
 */

/** The comments of a YAML text, each as written; the lexer tells a comment from a `#` inside a value. */
function comments(text: string): string[] {
  const found: string[] = [];
  for (const token of new Lexer().lex(text)) if (token.startsWith("#")) found.push(token.trim());
  return found;
}

/** How many of the comments in `before` the rewritten text no longer holds. */
function droppedComments(before: string, after: string): number {
  const left = comments(after);
  let dropped = 0;
  for (const comment of comments(before)) {
    const at = left.indexOf(comment);
    if (at >= 0) left.splice(at, 1);
    else dropped++;
  }
  return dropped;
}

export const fmt: CommandSpec = {
  name: "fmt",
  summary: "Bring the package files into the export's form (field order and defaults from the package schema), offline.",
  description:
    "A file whose value the export would spell differently is rewritten: each field in the schema's order, and each field it\n" +
    "leaves out set to what the instance gives it, as the export writes it: the schema's default, an empty list or object for\n" +
    "a list or object field without one. The instance applies the same values, so nothing changes in what apply sends but the\n" +
    "spelling, with one exception: an entry of a list that leaves out an `..._order` field (sort_order, display_order,\n" +
    "step_order) gets its position, so the instance keeps the written order instead of ordering entries that all carry the\n" +
    "default its own way (test cases by name). Lists become block lists; the persona file shows every field, the unset\n" +
    "ones as comments. Comments in a rewritten file are not kept, as pull does not keep them: fmt names each file whose\n" +
    "comments it drops (with --check, would drop), so keep notes you need elsewhere first. A file already in that form\n" +
    "keeps its bytes, and so do the files of sections the schema does not know. Run it after writing package files by hand\n" +
    "and before `apply`, so the next `pull` shows only what changed on the instance. --check writes nothing and exits 3 when a\n" +
    "file would change. Uses the cached package schema (as validate does); --offline never contacts the instance.",
  readOnly: false,
  idempotent: true,
  mcpTool: "fmt",
  mcpEffect: "Changes nothing on the instance. Rewrites package files in the solution folder (not with check).",
  options: {
    check: { type: "boolean", description: "Write nothing; exit 3 when a file would change." },
    offline: { type: "boolean", description: "Never contact the instance, even when no schema is cached." },
  },
  examples: ["cavelon fmt", "cavelon fmt --check"],
  async run(ctx, input) {
    const session = await ctx.session();
    const project = requireSolution(session);
    requireInstance(session);
    const check = boolOption(input, "check");
    const disk = await readPackage(project.root, project.layout);
    const invalid = disk.findings.filter((f) => f.severity === "error");
    if (invalid.length) {
      throw new CavelonError(ExitCode.validation, {
        code: "package_file_invalid",
        message: `${invalid.length} package file${invalid.length === 1 ? "" : "s"} cannot be read: ${invalid.map((f) => `${f.file}${f.line ? `:${f.line}` : ""}`).join(", ")}.`,
        hint: "Fix them first (`cavelon validate` names each); fmt changes nothing until then.",
      });
    }
    const version = packageVersionOf(disk.package) ?? project.packageVersion;
    const { schema } = await schemaFor(ctx, version, boolOption(input, "offline"));
    if (!schema) {
      throw new CavelonError(ExitCode.failure, {
        code: "package_schema_unavailable",
        message: `No package schema${version ? ` for format ${version}` : ""} is cached for this instance, and it was not read.`,
        hint: "Run `cavelon fmt` (or `cavelon validate`) once without --offline while the instance is reachable.",
      });
    }

    const changes: Array<{ file: string; content: string }> = [];
    let unchanged = 0;
    for (const [section, source] of Object.entries(disk.sources)) {
      const node = schema.properties?.[section];
      // A section the schema does not know is sent as it is; its files stay byte for byte.
      if (!node) continue;
      if (Array.isArray(source)) {
        const items = Array.isArray(disk.package[section]) ? (disk.package[section] as unknown[]) : [];
        source.forEach((s, i) => {
          const item = items[i];
          const formed = (exportForm(schema, node, [item]) as unknown[])[0];
          if (canonical(item) === canonical(formed)) unchanged++;
          else changes.push({ file: s.file, content: toYaml(formed) });
        });
        continue;
      }
      const value = disk.package[section];
      const formed = exportForm(schema, node, value);
      if (canonical(value ?? null) === canonical(formed ?? null)) unchanged++;
      else changes.push({ file: source.file, content: sectionContent(section, formed, schema, /\.json$/i.test(source.file)) });
    }

    // What a rewrite loses: the example files explain their fields in comments.
    const dropped: Array<{ file: string; comments: number }> = [];
    for (const change of changes) {
      if (/\.json$/i.test(change.file)) continue;
      const target = await contentPath(project.root, path.join(project.root, change.file));
      const before = target === undefined ? undefined : await readTextFile(target);
      const count = before === undefined ? 0 : droppedComments(before, change.content);
      if (count) dropped.push({ file: change.file, comments: count });
    }
    // A file committed as it is comes back with git; asked before the rewrite, which changes them all.
    const dirty = !check && changes.length ? await uncommitted(project.root, changes.map((c) => c.file)) : undefined;
    const restorable = (file: string) => dirty !== undefined && !dirty.includes(file);
    const written: string[] = [];
    if (!check && changes.length) {
      const known = await readPulledFiles(project.root);
      const wasKnown: string[] = [];
      for (const change of changes) {
        const file = path.join(project.root, change.file);
        // A file behind a link is written there, so the link stays a link; never outside the solution.
        const target = await contentPath(project.root, file);
        if (target === undefined) continue;
        if ((await readTextFile(target)) === change.content) continue;
        if (known[change.file] !== undefined && known[change.file] === (await fileDigest(file))) wasKnown.push(change.file);
        await writeFileAtomic(target, change.content);
        written.push(change.file);
      }
      // A file pull or apply left holds the same value in its new spelling; a later pull may replace it as before.
      if (wasKnown.length) await rememberAppliedFiles(project.root, await fileDigests(project.root, wasKnown));
    }
    const files = changes.map((c) => c.file).sort((a, b) => a.localeCompare(b, "en"));
    const lost = check ? dropped : dropped.filter((d) => written.includes(d.file));
    const data = { check, changed: files, written: written.sort((a, b) => a.localeCompare(b, "en")), unchanged, comments_dropped: lost };
    const commentList = lost.map((d) => `${d.file} (${d.comments})`).join(", ");
    if (check) {
      return {
        data,
        text: files.length
          ? [
              ...files.map((f) => `would format  ${f}`),
              `${files.length} file${files.length === 1 ? "" : "s"} not in the export's form; run \`cavelon fmt\`.`,
              ...(lost.length ? [`fmt would drop the comments of ${commentList}; keep notes you need elsewhere first.`] : []),
            ].join("\n")
          : `All ${unchanged} package files are in the export's form.`,
        exitCode: files.length ? ExitCode.validation : ExitCode.ok,
      };
    }
    if (lost.length) {
      const back = lost.filter((d) => restorable(d.file)).map((d) => d.file);
      ctx.warn(
        `fmt dropped the comments of ${commentList}; the export's form has none, as pull keeps none. ` +
          (back.length === lost.length
            ? "They were committed: git diff shows them, and git restore brings a file back."
            : back.length
              ? `git restore brings back ${back.join(", ")}; the others were not committed.`
              : dirty === undefined
                ? "The folder is not in a git repository, so nothing brings them back."
                : "The files were not committed, so git cannot bring the comments back."),
      );
    }
    // git diff compares with the last commit: for a file not committed as it was, it shows nothing useful.
    const diffable = written.some(restorable);
    return {
      data,
      text: [
        ...written.map((f) => `formatted  ${f}`),
        `${written.length} file${written.length === 1 ? "" : "s"} formatted, ${unchanged} already in the export's form.`,
        ...(written.length ? [diffable ? "Check it: cavelon validate; then git diff shows what changed." : "Check it: cavelon validate."] : []),
      ].join("\n"),
    };
  },
};
