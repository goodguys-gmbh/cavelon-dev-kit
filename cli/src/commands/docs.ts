import { intOption, positional, type CommandSpec, type Context } from "../command.js";
import { CavelonError, ExitCode } from "../errors.js";
import { table } from "../format.js";
import { NOT_HERE, type ApiClient } from "../http.js";
import { cavelonCommand } from "../shell.js";

/**
 * The instance's own docs, at its own version: `GET /llms.txt` lists the
 * pages a caller may read (`- [Title](url): description` under `## Section`),
 * and each page is one markdown document.
 */

export interface DocEntry {
  page: string;
  title: string;
  description: string;
  section: string;
  url: string;
}

const INDEX_PATHS = ["/llms.txt", "/api/v1/docs/llms.txt"];

function unavailable(url: string): CavelonError {
  return new CavelonError(ExitCode.failure, {
    code: "docs_unavailable",
    message: `${url} does not serve its docs to agents (no /llms.txt).`,
    hint: "The instance is older than the docs endpoints; read the docs in the Admin until it is updated.",
  });
}

function looksLikeIndex(text: string): boolean {
  return /^\s*#\s/.test(text) && !/^\s*<(!doctype|html)/i.test(text);
}

async function fetchIndex(client: ApiClient): Promise<string> {
  for (const candidate of INDEX_PATHS) {
    const response = await client.get<string>(candidate, { accept: "text/plain, text/markdown", allow: NOT_HERE.filter((s) => s !== 401 && s !== 403) });
    if (response.status === 200 && typeof response.data === "string" && looksLikeIndex(response.text)) return response.text;
  }
  throw unavailable(client.url);
}

export function parseIndex(text: string, base: string): DocEntry[] {
  const entries: DocEntry[] = [];
  let section = "";
  for (const line of text.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      section = heading[1]!;
      continue;
    }
    const link = /^\s*[-*]\s+\[([^\]]+)\]\(([^)\s]+)\)(?::\s*(.*))?$/.exec(line);
    if (!link) continue;
    // The index may name the instance by an internal host name behind a proxy;
    // keep only the path and read it from the URL the kit talks to.
    const pathname = new URL(link[2]!, `${base}/`).pathname;
    const url = `${new URL(base).origin}${pathname}`;
    const page = pathname.replace(/^.*?\/docs\//, "").replace(/^\//, "").replace(/\.md$/, "");
    entries.push({ page, title: link[1]!, description: (link[3] ?? "").trim(), section, url });
  }
  return entries;
}

async function loadIndex(ctx: Context): Promise<{ client: ApiClient; entries: DocEntry[]; text: string }> {
  const client = await ctx.optionalClient();
  let text: string;
  if (client.target.token) {
    text = await (await ctx.contracts()).text("llms.txt", () => fetchIndex(client));
  } else {
    text = await fetchIndex(client);
  }
  return { client, entries: parseIndex(text, client.url), text };
}

/**
 * The pages of these that this instance's docs index lists, in the order
 * given; none when the index cannot be read. A command links a page only
 * where the instance publishes it.
 */
export async function listedPages(ctx: Context, pages: string[]): Promise<string[]> {
  try {
    const { entries } = await loadIndex(ctx);
    return pages.filter((page) => entries.some((e) => e.page === page));
  } catch {
    return [];
  }
}

/**
 * Words that say nothing about a page, in the two languages people ask in:
 * question words, articles, pronouns, prepositions and the verbs every
 * question uses. Without them, "Wie lade ich Dokumente in eine Wissensbasis
 * hoch?" matched every page with "in" in its summary.
 */
const STOP_WORDS = new Set(
  (
    "a an and are as at be by can could do does for from get got have how i in into is it its me my of on or our should so " +
    "that the their them then there these this those to use using was we what when where which who why will with would you your " +
    "aber alle als am an auch auf aus bei bin bis da damit dann das dass dem den der des die dies diese diesem diesen dieser " +
    "doch du ein eine einem einen einer eines er es für geht gibt hat habe haben ich ihr im in ist ja kann kannst können man " +
    "mein meine meinem meinen meiner mich mir mit muss müssen nach nicht noch nur ob oder sich sie sind so soll um und uns " +
    "unser unsere vom von vor war was welche welcher welches wenn wer werden wie wird wo zu zum zur"
  ).split(" "),
);

/**
 * Words people ask with for the core concepts, in the English the docs are
 * written in: German ones, as the instance's docs index is English, and "bot",
 * which the docs call a solution. A value of two words also counts as a phrase.
 */
const CONCEPT_TERMS: Record<string, string> = {
  bot: "solution",
  bots: "solution",
  chatbot: "solution",
  wissensbasis: "knowledge base",
  wissensbasen: "knowledge base",
  wissensdatenbank: "knowledge base",
  wissensdatenbanken: "knowledge base",
  dokument: "document",
  dokumente: "document",
  dokumenten: "document",
  datei: "file",
  dateien: "file",
  hochladen: "upload",
  lade: "upload",
  laden: "upload",
  hoch: "upload",
  teste: "test",
  testen: "test",
  testet: "test",
  tests: "test",
  testfall: "test case",
  testfälle: "test case",
  agent: "agent",
  agenten: "agent",
  standard: "default",
  standardmodell: "default model",
  standardantwort: "default answer",
  antwort: "answer",
  antworten: "answer",
  nutzer: "user",
  benutzer: "user",
  standardmäßig: "default",
  voreinstellung: "default",
  modell: "model",
  modelle: "model",
  sprachmodell: "model",
  werkzeug: "tool",
  werkzeuge: "tool",
  fähigkeit: "skill",
  fähigkeiten: "skill",
  lösung: "solution",
  lösungen: "solution",
  auslöser: "trigger",
  geheimnis: "secret",
  geheimnisse: "secret",
  variablen: "variable",
  grenze: "limit",
  grenzen: "limit",
  gedächtnis: "memory",
  erinnerung: "memory",
  übergabe: "handoff",
  übergaben: "handoff",
  freigabe: "approval",
  genehmigung: "approval",
  kanal: "channel",
  kanäle: "channel",
  ablaufverfolgung: "trace",
  protokoll: "trace",
  aktivieren: "activate",
  veröffentlichen: "activate",
  bereitstellen: "deploy",
  anmelden: "login",
  mandant: "tenant",
  mandanten: "tenant",
  persona: "persona",
  leitplanken: "guardrail",
  schleife: "loop",
  kosten: "cost",
  kapazität: "capacity",
  begrüßung: "greeting",
  begrüssung: "greeting",
  begrüßungen: "greeting",
  begrüßungsnachricht: "greeting",
  begrüßungstext: "greeting",
  willkommensnachricht: "greeting",
  webseite: "website",
  homepage: "website",
  einbinden: "embed",
  binde: "embed",
  einbetten: "embed",
  bette: "embed",
  speichern: "store",
  speichere: "store",
  hinterlegen: "store",
  hinterlege: "store",
  schlüssel: "key",
  passwort: "password",
  zugangsdaten: "credential",
  falsch: "wrong",
  falsche: "wrong",
  falschen: "wrong",
  geantwortet: "answer",
  antwortet: "answer",
  fehler: "error",
  ändern: "change",
  ändere: "change",
};

/**
 * Words a beginner asks with that the docs' titles and summaries rarely use,
 * and the words those pages do use: a greeting is set on the persona, a
 * website gets the widget, a tool's API key is a secret, a wrong answer is
 * found in the Playground's traces. Keyed by the term's base form (`stem`);
 * the words added count like the question's own, not as a phrase.
 */
const RELATED_TERMS: Record<string, string[]> = {
  greet: ["persona"],
  greeting: ["persona"],
  welcome: ["greeting", "persona"],
  website: ["widget", "embed"],
  site: ["widget", "embed"],
  embed: ["widget"],
  key: ["secret", "credential"],
  password: ["secret", "credential"],
  credential: ["secret"],
  wrong: ["debug", "trace"],
  incorrect: ["debug", "trace"],
  error: ["debug", "trace"],
  debug: ["trace", "playground"],
};

/**
 * Words nearly every page and question shares ("Why did my agent answer
 * wrong?" is no question about agents): they count, but a fraction of a word
 * that tells pages apart, so they no longer pull every page about agents to
 * the top.
 */
const GENERIC_TERMS = new Set(["agent", "cavelon"]);
const GENERIC_WEIGHT = 0.3;

/**
 * Words whose meaning the rest of the question decides: an API key asked
 * about with a tool is the tool's credential, kept as a secret, not one of
 * the tenant's API keys. Then `damp` counts like a generic word.
 */
const IN_CONTEXT: Array<{ all: string[]; any: string[]; add: string[]; damp: string[] }> = [
  { all: ["key"], any: ["tool", "webhook", "integration", "mcp"], add: ["secret"], damp: ["api", "key"] },
];

/** A word in a simple base form, so "documents" meets "document" and "testing" meets "test". */
function stem(word: string): string {
  if (word.length > 5 && word.endsWith("ing")) {
    const base = word.slice(0, -3);
    // "debugging" meets "debug", "mapping" meets "map": a doubled last letter is the spelling's, not the word's.
    return base.length > 3 && base[base.length - 1] === base[base.length - 2] && !/[aeiouls]/.test(base[base.length - 1]!) ? base.slice(0, -1) : base;
  }
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** The query's terms: stop words dropped, German concept words in English, each in its base form. */
export function queryTerms(query: string): { terms: string[]; phrases: string[][]; damped: string[] } {
  const terms: string[] = [];
  const phrases: string[][] = [];
  const raw = words(query).filter((w) => !STOP_WORDS.has(w));
  for (const word of raw) {
    const english = CONCEPT_TERMS[word];
    const parts = english ? english.split(" ") : [word];
    if (parts.length > 1) phrases.push(parts.map(stem));
    for (const part of parts) if (part.length > 1 || /\p{N}/u.test(part)) terms.push(stem(part));
  }
  // Two terms in a row of the question are a phrase too: "knowledge base", "test suite".
  for (let i = 0; i + 1 < terms.length; i++) phrases.push([terms[i]!, terms[i + 1]!]);
  const related = terms.flatMap((t) => RELATED_TERMS[t] ?? []).map(stem);
  const damped: string[] = [];
  for (const rule of IN_CONTEXT) {
    if (!rule.all.every((t) => terms.includes(t)) || !rule.any.some((t) => terms.includes(t))) continue;
    related.push(...rule.add.map(stem));
    damped.push(...rule.damp);
  }
  return { terms: [...new Set([...terms, ...related])], phrases, damped };
}

/** The base forms of a field's words, in order. */
function fieldWords(text: string): string[] {
  return words(text).map(stem);
}

function hasPhrase(field: string[], phrase: string[]): boolean {
  for (let i = 0; i + phrase.length <= field.length; i++) {
    if (phrase.every((w, j) => field[i + j] === w)) return true;
  }
  return false;
}

/** A page must show this much evidence to be listed: a word of the question in its title, or two in its summary or address. */
const MIN_EVIDENCE = 2;
/** And a fair share of the best page's score, so one shared word does not list half the index. */
const MIN_SHARE_OF_BEST = 0.35;

export function searchIndex(entries: DocEntry[], query: string): Array<DocEntry & { score: number }> {
  const { terms, phrases, damped } = queryTerms(query);
  if (!terms.length) return [];
  const fields = entries.map((entry) => ({
    entry,
    title: fieldWords(entry.title),
    page: fieldWords(entry.page),
    description: fieldWords(entry.description),
    section: fieldWords(entry.section),
  }));
  // A word on few pages says more than one on many: "test" outweighs "agent".
  const weight = new Map<string, number>();
  for (const term of terms) {
    const pages = fields.filter((f) => f.title.includes(term) || f.page.includes(term) || f.description.includes(term)).length;
    weight.set(term, Math.log(1 + entries.length / (1 + pages)) * (GENERIC_TERMS.has(term) || damped.includes(term) ? GENERIC_WEIGHT : 1));
  }
  const scored = fields
    .map(({ entry, title, page, description, section }) => {
      let evidence = 0;
      let score = 0;
      for (const term of terms) {
        const hits = (title.includes(term) ? 3 : 0) + (page.includes(term) ? 2 : 0) + (description.includes(term) ? 1 : 0) + (section.includes(term) ? 1 : 0);
        evidence += hits;
        score += hits * weight.get(term)!;
      }
      for (const phrase of phrases) {
        const w = Math.max(...phrase.map((t) => weight.get(t) ?? 1));
        if (hasPhrase(title, phrase)) score += 3 * w;
        else if (hasPhrase(description, phrase)) score += w;
      }
      // A title the question names nearly whole ("Triggers", "Knowledge Bases and Retrieval") is the page it asks for.
      const titleWords = title.filter((w) => !STOP_WORDS.has(w));
      const named = titleWords.filter((w) => terms.includes(w));
      if (titleWords.length && named.length / titleWords.length >= 0.5) score += (3 * named.length * Math.max(...named.map((t) => weight.get(t)!))) / titleWords.length;
      // A page in Concepts explains the idea a beginner asks about; it goes first among near equals.
      if (score > 0 && section.includes("concept")) score *= 1.15;
      return { ...entry, score: Math.round(score * 100) / 100, evidence };
    })
    .filter((e) => e.evidence >= MIN_EVIDENCE);
  const best = Math.max(0, ...scored.map((e) => e.score));
  return scored
    .filter((e) => e.score >= best * MIN_SHARE_OF_BEST)
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .map(({ evidence: _evidence, ...e }) => e);
}

/** What `docs get` takes for the whole index of pages. */
const INDEX_REF = "index";

export const docsSearch: CommandSpec = {
  name: "docs search",
  summary: "Search this instance's docs (titles and summaries).",
  description:
    "Ranks the pages of the instance's docs index by the words of the question in their titles, addresses and\n" +
    "summaries, rare words counting more than common ones. Stop words (English and German) are ignored, words match\n" +
    "whole (\"test\" finds \"testing\", not \"latest\"), and German words for the core concepts are looked up in English\n" +
    "(Wissensbasis: knowledge base). Only pages that match well are listed.",
  readOnly: true,
  idempotent: true,
  mcpTool: "docs_search",
  positionals: [{ name: "query", description: "What to look for.", required: true, variadic: true }],
  options: { limit: { type: "string", value: "<n>", description: "Return at most n pages (default 10)." } },
  async run(ctx, input) {
    const query = ((input.positionals.query as string[] | undefined) ?? []).join(" ");
    const limit = intOption(input, "limit", { min: 1, max: 100, fallback: 10 })!;
    const { entries } = await loadIndex(ctx);
    const hits = searchIndex(entries, query);
    const { terms } = queryTerms(query);
    const items = hits.slice(0, limit).map(({ page, title, description, section }) => ({ page, title, section, description }));
    const none =
      `No page matches "${query}"${terms.length ? ` (looked for: ${terms.join(", ")})` : " (it has only stop words)"}. ` +
      `The docs are in English: try English words for the concept (knowledge base, test, trigger, default), ` +
      `or read the list of all ${entries.length} pages with: ${cavelonCommand("docs", "get", INDEX_REF)}`;
    return {
      data: { query, terms, items, total: hits.length, ...(items.length ? {} : { hint: none }) },
      text: items.length ? `${table(items, ["page", "title", "description"], 70)}\n\nRead one: cavelon docs get <page>` : none,
    };
  },
};

export const docsGet: CommandSpec = {
  name: "docs get",
  summary: "Print one docs page as markdown.",
  readOnly: true,
  idempotent: true,
  mcpTool: "docs_get",
  positionals: [{ name: "page", description: "section/slug from `docs search`, a title, the page URL, or `index` for the list of all pages.", required: true }],
  options: {
    "max-chars": { type: "string", value: "<n>", description: "Print at most n characters (default 40000)." },
    cursor: { type: "string", value: "<offset>", description: "Continue a long page where the previous output stopped." },
  },
  async run(ctx, input) {
    const ref = positional(input, "page")!;
    const { client, entries, text: index } = await loadIndex(ctx);
    const wanted = ref.replace(/\.md$/, "").replace(/^\/+/, "");
    const entry =
      entries.find((e) => e.page === wanted || e.url === ref) ??
      entries.find((e) => e.title.toLowerCase() === ref.toLowerCase()) ??
      entries.find((e) => e.page.endsWith(`/${wanted}`));
    const max = intOption(input, "max-chars", { min: 100, fallback: 40_000 })!;
    const offset = intOption(input, "cursor", { min: 0, fallback: 0 })!;
    if (!entry && (wanted === INDEX_REF || wanted === "llms.txt")) {
      const chunk = index.slice(offset, offset + max);
      const next = offset + max < index.length ? String(offset + max) : null;
      return {
        data: { page: INDEX_REF, title: "Docs index", url: `${client.url}/llms.txt`, markdown: chunk, next_cursor: next, length: index.length },
        text: chunk + (next ? `\n\n… index continues: ${cavelonCommand("docs", "get", INDEX_REF, "--cursor", next)}` : ""),
      };
    }
    if (!entry) {
      const near = searchIndex(entries, ref.replace(/[/-]/g, " ")).slice(0, 5).map((e) => e.page);
      throw new CavelonError(ExitCode.failure, {
        code: "doc_not_found",
        message: `No docs page "${ref}" on this instance.`,
        hint: near.length ? `Did you mean: ${near.join(", ")}?` : "Find it with `cavelon docs search <words>`.",
      });
    }
    const response = await client.get<string>(entry.url, { accept: "text/markdown, text/plain" });
    const markdown = response.text;
    const chunk = markdown.slice(offset, offset + max);
    const next = offset + max < markdown.length ? String(offset + max) : null;
    return {
      data: { page: entry.page, title: entry.title, url: entry.url, markdown: chunk, next_cursor: next, length: markdown.length },
      text: chunk + (next ? `\n\n… page continues: ${cavelonCommand("docs", "get", entry.page, "--cursor", next)}` : ""),
    };
  },
};
