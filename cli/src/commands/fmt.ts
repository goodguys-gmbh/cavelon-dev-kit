import path from "node:path";
import { boolOption, type CommandSpec } from "../command.js";
import { CavelonError, ExitCode } from "../errors.js";
import { readTextFile, writeFileAtomic } from "../fsutil.js";
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

export const fmt: CommandSpec = {
  name: "fmt",
  summary: "Bring the package files into the export's form (field order and defaults from the package schema), offline.",
  description:
    "A file whose value the export would spell differently is rewritten: each field in the schema's order, and each field it\n" +
    "leaves out set to the schema's default, as the export writes it (the instance applies the same defaults, so nothing\n" +
    "changes in what apply sends but the spelling). Lists become block lists; the persona file shows every field, the unset\n" +
    "ones as comments. Comments in a rewritten file are not kept, as pull does not keep them. A file already in that form\n" +
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
    const data = { check, changed: files, written: written.sort((a, b) => a.localeCompare(b, "en")), unchanged };
    if (check) {
      return {
        data,
        text: files.length
          ? [...files.map((f) => `would format  ${f}`), `${files.length} file${files.length === 1 ? "" : "s"} not in the export's form; run \`cavelon fmt\`.`].join("\n")
          : `All ${unchanged} package files are in the export's form.`,
        exitCode: files.length ? ExitCode.validation : ExitCode.ok,
      };
    }
    return {
      data,
      text: [
        ...written.map((f) => `formatted  ${f}`),
        `${written.length} file${written.length === 1 ? "" : "s"} formatted, ${unchanged} already in the export's form.`,
        ...(written.length ? ["Check it: cavelon validate; then git diff shows only the spelling."] : []),
      ].join("\n"),
    };
  },
};
