import { promises as fs } from "node:fs";
import { drivenByAgent } from "../agent-env.js";
import { intOption, positional, stringOption, type CommandSpec, type Context, type Input } from "../command.js";
import { CavelonError, ExitCode, usageError } from "../errors.js";
import { table } from "../format.js";
import { callOperation, callStable, workflowOperation } from "../invoke.js";
import { confinedPath } from "../paths.js";
import { resolveKbId } from "./work.js";

const DOCUMENTS = "/api/v1/knowledge-bases/{kb_id}/documents";
const FILES = `${DOCUMENTS}/{doc_id}/files`;
const REVIEW = "A person with knowledge_bases.manage_documents reviews and releases it in the Admin. Tokens and API keys cannot release it; YOLO does not change this.";

interface DocumentFiles {
  document_id: string;
  status: string;
  privacy: Record<string, unknown> | null;
  files: Array<{ id: string; kind: string; filename: string; content_type: string; size_bytes: number; agent_readable: boolean; restricted: boolean }>;
}

const kbOption = { type: "string" as const, value: "<name-or-id>", description: "The knowledge base's name or id." };

async function kbOf(ctx: Context, input: Input): Promise<string> {
  const ref = stringOption(input, "kb");
  if (!ref) throw usageError("Which knowledge base?", "Pass --kb <name-or-id>.");
  return (await resolveKbId(ctx, ref)).id;
}

async function filesOf(ctx: Context, kb: string, document: string): Promise<DocumentFiles> {
  return callStable(ctx, "GET", FILES, "a document's conversion files", { params: { kb_id: [kb], doc_id: [document] } });
}

export const kbDocuments: CommandSpec = {
  name: "kb documents",
  summary: "List documents and their status, including those held for privacy review.",
  readOnly: true,
  idempotent: true,
  mcpTool: "kb_documents",
  operations: [`GET ${DOCUMENTS}`],
  options: { kb: kbOption, limit: { type: "string", value: "<n>", description: "Show at most n documents (default 50, at most 200)." } },
  examples: ["cavelon kb documents --kb Records --json"],
  async run(ctx, input) {
    const kb = await kbOf(ctx, input);
    const limit = intOption(input, "limit", { min: 1, max: 200, fallback: 50 })!;
    const documents = await callStable<Array<{ id: string; filename: string; status: string }>>(ctx, "GET", DOCUMENTS, "a knowledge base's documents", { params: { kb_id: [kb] } });
    const items = documents.slice(0, limit).map(d => ({ ...d, needs_person: d.status === "held" }));
    if (documents.length > limit) ctx.warn(`Showing ${limit} of ${documents.length} documents. cavelon api list_documents --limit 0 --output <file> saves the full list; pass kb_id too.`);
    return {
      data: { kb_id: kb, items, total: documents.length },
      text: (table(items, ["filename", "status", "needs_person", "id"]) || "No documents.") + (items.some(d => d.needs_person) ? `\n\nheld: not indexed or readable. ${REVIEW}` : ""),
    };
  },
};

export const kbFiles: CommandSpec = {
  name: "kb files",
  summary: "List a document's conversion file ids, access flags and privacy summary.",
  description: "The list contains metadata only. Restricted reports and privacy vaults remain dashboard-only; a held document cannot be read or downloaded.",
  readOnly: true,
  idempotent: true,
  mcpTool: "kb_files",
  operations: [`GET ${FILES}`],
  positionals: [{ name: "document", description: "Document id.", required: true }],
  options: { kb: kbOption },
  examples: ["cavelon kb files <document-id> --kb Records --json"],
  async run(ctx, input) {
    const data = await filesOf(ctx, await kbOf(ctx, input), positional(input, "document")!);
    return {
      data,
      text: [`Document ${data.document_id}: ${data.status}`, table(data.files, ["kind", "filename", "size_bytes", "agent_readable", "restricted", "id"]) || "No conversion files.", ...(data.privacy ? [`Privacy summary: ${JSON.stringify(data.privacy)}`] : []), ...(data.status === "held" ? [REVIEW] : [])].join("\n\n"),
    };
  },
};

export const kbDownload: CommandSpec = {
  name: "kb download",
  summary: "Save a document or one of its readable conversion files without overwriting a local file.",
  description: "Without --file, the instance serves the redacted PDF where privacy_document is on. --file takes an id from kb files, never a filename or URL. Reports and vaults require a dashboard person. Output from an agent stays inside the solution folder.",
  readOnly: true,
  mcpTool: "kb_download",
  operations: [`GET ${FILES}`, `GET ${FILES}/{file_id}`, `GET ${DOCUMENTS}/{doc_id}/download`],
  positionals: [{ name: "document", description: "Document id.", required: true }],
  options: { kb: kbOption, file: { type: "string", value: "<file-id>", description: "Id of an agent-readable conversion file from kb files." }, output: { type: "string", value: "<path>", description: "New local file to write; required." } },
  examples: ["cavelon kb download <document-id> --kb Records --output record.pdf", "cavelon kb download <document-id> --kb Records --file <file-id> --output tables.xlsx"],
  async run(ctx, input) {
    const raw = stringOption(input, "output");
    if (!raw) throw usageError("Where should the file be saved?", "Pass --output <path> for a new file.");
    const output = await confinedPath(ctx, raw, "The output file", drivenByAgent(ctx) !== undefined);
    const kb = await kbOf(ctx, input);
    const document = positional(input, "document")!;
    const listing = await filesOf(ctx, kb, document);
    if (listing.status === "held") throw new CavelonError(ExitCode.needsAction, { code: "held_for_privacy_review", message: "This document is held for privacy review and cannot be read or downloaded.", hint: REVIEW });
    const id = stringOption(input, "file");
    const file = id ? listing.files.find(f => f.id === id) : undefined;
    if (id && !file) throw usageError("That file id is not listed for this document.", "Choose an id from kb files.");
    if (file && (file.restricted || file.agent_readable !== true || file.kind === "privacy_vault" || file.kind === "conversion_report")) throw new CavelonError(ExitCode.needsAction, { code: "document_file_for_a_person", message: "This file is not available to agents or tokens.", hint: "A person with knowledge_bases.manage_documents opens the restricted file in the Admin. The privacy vault and conversion report are never agent-readable." });
    const route = file ? `${FILES}/{file_id}` : `${DOCUMENTS}/{doc_id}/download`;
    const { doc, op } = await workflowOperation(ctx, "GET", route, "downloading a document file");
    // Create exclusively before the request: a customer's existing file stays intact.
    let handle;
    try { handle = await fs.open(output, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw usageError(`The output file ${raw} already exists.`, "Choose a new output path.");
      throw error;
    }
    let bytes: number;
    try {
      const response = await callOperation(ctx, await ctx.client(), doc, op, { params: { kb_id: [kb], doc_id: [document], ...(file ? { file_id: [file.id] } : {}) } });
      const body = response.bytes ?? Buffer.from(typeof response.data === "string" ? response.data : response.data == null ? "" : JSON.stringify(response.data));
      await handle.writeFile(body);
      bytes = body.length;
    } catch (error) {
      await handle.close();
      await fs.unlink(output);
      throw error;
    }
    await handle.close();
    return { data: { document_id: document, file_id: file?.id ?? null, kind: file?.kind ?? null, written: raw, bytes }, text: `Wrote ${bytes} bytes to ${raw}.` };
  },
};
