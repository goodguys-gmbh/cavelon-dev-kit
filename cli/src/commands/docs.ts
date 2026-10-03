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

async function loadIndex(ctx: Context): Promise<{ client: ApiClient; entries: DocEntry[] }> {
  const client = await ctx.optionalClient();
  let text: string;
  if (client.target.token) {
    text = await (await ctx.contracts()).text("llms.txt", () => fetchIndex(client));
  } else {
    text = await fetchIndex(client);
  }
  return { client, entries: parseIndex(text, client.url) };
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

function terms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length > 1);
}

export function searchIndex(entries: DocEntry[], query: string): Array<DocEntry & { score: number }> {
  const words = terms(query);
  const phrase = query.trim().toLowerCase();
  return entries
    .map((entry) => {
      const title = entry.title.toLowerCase();
      const description = entry.description.toLowerCase();
      const page = entry.page.toLowerCase();
      const section = entry.section.toLowerCase();
      let score = 0;
      if (phrase && title.includes(phrase)) score += 10;
      if (phrase && description.includes(phrase)) score += 4;
      for (const word of words) {
        if (title.includes(word)) score += 3;
        if (page.includes(word)) score += 2;
        if (description.includes(word)) score += 1;
        if (section.includes(word)) score += 1;
      }
      return { ...entry, score };
    })
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
}

export const docsSearch: CommandSpec = {
  name: "docs search",
  summary: "Search this instance's docs (titles and summaries).",
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
    const items = hits.slice(0, limit).map(({ page, title, description, section }) => ({ page, title, section, description }));
    return {
      data: { query, items, total: hits.length },
      text: items.length
        ? `${table(items, ["page", "title", "description"], 70)}\n\nRead one: cavelon docs get <page>`
        : `No page matches "${query}". The index has ${entries.length} pages.`,
    };
  },
};

export const docsGet: CommandSpec = {
  name: "docs get",
  summary: "Print one docs page as markdown.",
  readOnly: true,
  idempotent: true,
  mcpTool: "docs_get",
  positionals: [{ name: "page", description: "section/slug from `docs search`, a title, or the page URL.", required: true }],
  options: {
    "max-chars": { type: "string", value: "<n>", description: "Print at most n characters (default 40000)." },
    cursor: { type: "string", value: "<offset>", description: "Continue a long page where the previous output stopped." },
  },
  async run(ctx, input) {
    const ref = positional(input, "page")!;
    const { client, entries } = await loadIndex(ctx);
    const wanted = ref.replace(/\.md$/, "").replace(/^\/+/, "");
    const entry =
      entries.find((e) => e.page === wanted || e.url === ref) ??
      entries.find((e) => e.title.toLowerCase() === ref.toLowerCase()) ??
      entries.find((e) => e.page.endsWith(`/${wanted}`));
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
    const max = intOption(input, "max-chars", { min: 100, fallback: 40_000 })!;
    const offset = intOption(input, "cursor", { min: 0, fallback: 0 })!;
    const chunk = markdown.slice(offset, offset + max);
    const next = offset + max < markdown.length ? String(offset + max) : null;
    return {
      data: { page: entry.page, title: entry.title, url: entry.url, markdown: chunk, next_cursor: next, length: markdown.length },
      text: chunk + (next ? `\n\n… page continues: ${cavelonCommand("docs", "get", entry.page, "--cursor", next)}` : ""),
    };
  },
};
