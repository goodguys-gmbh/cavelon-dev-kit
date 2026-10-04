import type { Context } from "./command.js";
import { CavelonError, ExitCode } from "./errors.js";
import { readLine } from "./prompt.js";

/**
 * Choosing one of several things by name: the numbered list a person picks
 * from on a terminal, and the closest candidates a miss names everywhere
 * else. A person types a number or part of a name; nobody has to find an id.
 */

export interface Named {
  name: string | null;
  slug: string | null;
  id: string;
}

/** At most this many entries are listed at once; more are narrowed by typing part of a name. */
export const MAX_LISTED = 20;
/** A person gets this many tries before the question gives up. */
const MAX_TRIES = 5;

function lower(value: string | null | undefined): string {
  return (value ?? "").toLowerCase();
}

/** An exact match by id, slug or name (case does not matter for the last two). */
export function exactMatch<T extends Named>(items: T[], ref: string): T | undefined {
  const wanted = ref.trim().toLowerCase();
  return (
    items.find((t) => t.id === ref.trim()) ??
    items.find((t) => lower(t.slug) === wanted) ??
    (() => {
      const byName = items.filter((t) => lower(t.name) === wanted);
      return byName.length === 1 ? byName[0] : undefined;
    })()
  );
}

/** The entries whose name or slug contains the text. */
export function containing<T extends Named>(items: T[], text: string): T[] {
  const wanted = text.trim().toLowerCase();
  return items.filter((t) => lower(t.name).includes(wanted) || lower(t.slug).includes(wanted));
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length]!;
}

/**
 * The entries closest to what was typed, best first: those whose name or slug
 * contains it (or is contained in it), then those a few typos away. At most
 * `max`, and none that are not close at all.
 */
export function closest<T extends Named>(items: T[], ref: string, max = 5): T[] {
  const wanted = ref.trim().toLowerCase();
  if (!wanted) return items.slice(0, max);
  const scored = items.flatMap((item) => {
    const words = [lower(item.slug), lower(item.name)].filter(Boolean);
    if (words.some((w) => w.includes(wanted))) return [{ item, score: 0 }];
    // A name inside what was typed counts only when it is more than a letter or two.
    if (words.some((w) => w.length >= 3 && wanted.includes(w))) return [{ item, score: 1 }];
    const distance = Math.min(...words.map((w) => editDistance(w, wanted)));
    return distance <= Math.max(2, Math.floor(wanted.length / 3)) ? [{ item, score: distance + 1 }] : [];
  });
  return scored
    .sort((a, b) => a.score - b.score)
    .slice(0, max)
    .map((s) => s.item);
}

/** "Acme Support (acme-support)", or whichever of the three is known. */
export function displayName(item: Named): string {
  if (item.name && item.slug && item.name !== item.slug) return `${item.name} (${item.slug})`;
  return item.name ?? item.slug ?? item.id;
}

export interface PickOptions<T extends Named> {
  /** Printed once above the list, e.g. "This token reaches 3 tenants on https://…:". */
  intro: string;
  /** The question, e.g. "Which tenant?". */
  question: string;
  items: T[];
  /** The rest of an entry's line after its name and slug, e.g. its role. */
  extra?(item: T): string | undefined;
  /** Chosen when the person just presses Enter. */
  preferred?: T;
  /**
   * Enter chooses nothing now: what the hint says Enter does, e.g. "choose
   * later". Takes the place of `preferred`.
   */
  later?: string;
  /**
   * More entries than the list holds: what the person types is searched for
   * (an operator's token that reaches every tenant). Answers the matches.
   */
  search?(text: string): Promise<T[]>;
  /** An entry that is not in the list, chosen by typing this word or the number after the list (e.g. "a new solution"). */
  other?: { label: string; word: string };
}

export type Picked<T> = { item: T } | { other: true } | { later: true };

function line(index: number, item: Named, extra: string | undefined, preferred: boolean): string {
  const slug = item.slug && item.slug !== item.name ? `  ${item.slug}` : "";
  const notes = [extra, preferred ? "default, press Enter" : undefined].filter(Boolean).join(", ");
  return `  ${String(index).padStart(2)}  ${item.name ?? item.slug ?? item.id}${slug}${notes ? `  (${notes})` : ""}`;
}

/**
 * Ask a person to choose one entry: a numbered list, then a number or part of
 * a name. Part of a name that fits one entry chooses it; one that fits several
 * lists those. Only on a terminal (the caller checks `canAsk`).
 */
export async function pick<T extends Named>(ctx: Context, options: PickOptions<T>): Promise<Picked<T>> {
  const write = (text: string) => ctx.io.stderr.write(`${text}\n`);
  let shown = options.items.slice(0, MAX_LISTED);
  const preferred = options.later ? undefined : options.preferred;
  const show = (items: T[]) => {
    items.forEach((item, i) => write(line(i + 1, item, options.extra?.(item), item === preferred)));
    if (options.other) write(`  ${String(items.length + 1).padStart(2)}  ${options.other.label}`);
  };
  write(options.intro);
  show(shown);
  if (options.items.length > shown.length) write(`  … and ${options.items.length - shown.length} more: type part of a name to find one.`);
  const typed = shown.length || options.other ? "type its number or part of its name" : "type part of its name";
  const hint = options.later ? `${typed}, or press Enter to ${options.later}` : typed;
  for (let tries = 0; tries < MAX_TRIES; tries++) {
    const answer = await readLine(ctx.io, `${options.question} ${ctx.style.dim(`(${hint})`)} `);
    if (!answer) {
      if (options.later) return { later: true };
      if (preferred) return { item: preferred };
      write("Type a number from the list, or part of a name.");
      continue;
    }
    if (options.other && answer.toLowerCase() === options.other.word) return { other: true };
    if (/^\d+$/.test(answer)) {
      const n = Number(answer);
      if (n >= 1 && n <= shown.length) return { item: shown[n - 1]! };
      if (options.other && n === shown.length + 1) return { other: true };
      write(`There is no number ${n} in the list.`);
      continue;
    }
    let found = containing(options.items, answer);
    if (!found.length && options.search) found = await options.search(answer);
    const exact = exactMatch(found, answer);
    if (exact) return { item: exact };
    if (found.length === 1) return { item: found[0]! };
    if (!found.length) {
      const near = closest(options.items, answer);
      write(`Nothing is called "${answer}".${near.length ? ` Did you mean ${near.map(displayName).join(", ")}?` : ""} Try another part of the name.`);
      continue;
    }
    shown = found.slice(0, MAX_LISTED);
    write(`${found.length} match "${answer}":`);
    show(shown);
    if (found.length > shown.length) write(`  … and ${found.length - shown.length} more: type more of the name.`);
  }
  throw new CavelonError(ExitCode.usage, { code: "cancelled", message: "Nothing was chosen.", hint: "Run the command again, or name it with an option." });
}
