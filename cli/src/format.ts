import { shellWord } from "./shell.js";

/** Short, plain text for a person; agents use --json. */

/** Rows as aligned columns, each cell cut at `maxWidth`; the columns in `whole` (a command to copy) are never cut. */
export function table(rows: Array<Record<string, unknown>>, columns: string[], maxWidth = 60, whole: string[] = []): string {
  if (rows.length === 0) return "";
  const cell = (value: unknown, column: string): string => {
    const text = value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
    const oneLine = text.replace(/\s+/g, " ");
    return oneLine.length > maxWidth && !whole.includes(column) ? `${oneLine.slice(0, maxWidth - 1)}…` : oneLine;
  };
  const cells = rows.map((row) => columns.map((c) => cell(row[c], c)));
  const widths = columns.map((c, i) => Math.max(c.length, ...cells.map((r) => r[i]!.length)));
  const line = (values: string[]) =>
    values
      .map((v, i) => (i === values.length - 1 ? v : v.padEnd(widths[i]!)))
      .join("  ")
      .trimEnd();
  return [line(columns.map((c) => c.toUpperCase())), ...cells.map(line)].join("\n");
}

export function keyValues(pairs: Array<[string, unknown]>): string {
  const shown = pairs.filter(([, v]) => v !== undefined);
  const width = Math.max(0, ...shown.map(([k]) => k.length));
  return shown
    .map(([k, v]) => `${`${k}:`.padEnd(width + 1)} ${v === null ? "-" : typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join("\n");
}

export function moreHint(nextCursor: string | null | undefined, command: string): string {
  return nextCursor ? `\nMore: ${command} --cursor ${shellWord(nextCursor)}` : "";
}

/** Cut a long text, saying how much was left out. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… (${text.length - max} more characters)`;
}

/** An instance's blocker sentences under one key, each on its own line, at most `max` of them. */
export function blockerLines(blockers: string[], max = 10): string {
  const shown = blockers.slice(0, max).map((b) => `\n  - ${clip(b, 400)}`);
  return `blockers:${shown.join("")}${blockers.length > max ? `\n  … ${blockers.length - max} more (--json)` : ""}`;
}
