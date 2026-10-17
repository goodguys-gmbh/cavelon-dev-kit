# Document tables, privacy and conversion files

These features require an instance that publishes the document-files operations.
`cavelon api describe <operation>` shows the instance's current contract. On an
older instance, a missing operation is reported as unavailable; the kit does not
pretend the feature is enabled.

## Configure a knowledge base

The five settings live in `document_processing_config`, on a knowledge base in
`package/knowledge_bases.yaml` or in the create/update API body:

| Key | Values | Meaning |
|---|---|---|
| `table_optimizer` | boolean | Transcribe, repair and check tables using the existing `vision_model`; there is no separate table model. |
| `export_tables_xlsx` | boolean | Save the tables as an Excel workbook beside the converted document. |
| `privacy_document` | `off`, `pseudonymize`, `anonymize` | Redact the stored PDF that readers and agents download. |
| `privacy_outputs` | `off`, `pseudonymize`, `anonymize` | Redact the indexed Markdown, workbook, pictures and table findings. |
| `privacy_model` | registry entry UUID or `null` | Select the names model by its registry **id**, not its `model_id`. |

Unset switches mean off. Use `cavelon models list --json` to find the names
model's `id`. It must be active, belong to the tenant and have a `base_url`.
OpenAI and Azure OpenAI providers and endpoints are refused by the instance.
Its credentials belong in the model registry, entered by a person in the Admin;
there are no `privacy_model_url` or `privacy_model_api_key` settings here.

```yaml
- name: Records
  document_processing_config:
    table_optimizer: true
    export_tables_xlsx: true
    privacy_document: pseudonymize
    privacy_outputs: anonymize
    privacy_model: <registry-entry-id>
```

Use the usual validate, preview and apply loop for a package change. To change
an existing KB directly, read its current configuration first and preserve the
other keys: the nested configuration is sent as a whole.

```sh
cavelon api get_knowledge_base kb_id=<kb-id> --json
cavelon api update_knowledge_base kb_id=<kb-id> --body @kb-update.json --json
```

`kb-update.json` contains `{"document_processing_config": {...}}`. Creating a
KB uses `create_knowledge_base` with `name` and that configuration. The instance
validates the types, privacy modes and model selection; its 400 message is
reported unchanged. Agent-driven writes retain the ordinary approval policy.

The existing `ocr_engine`, `do_ocr` and `table_mode` values are unchanged.
`bitmap_area_threshold` has no effect with the instance's current OCR engine.

## Inspect and download files

```sh
cavelon kb documents --kb Records --json
cavelon kb files <document-id> --kb Records --json
cavelon kb download <document-id> --kb Records --output record.pdf
cavelon kb download <document-id> --kb Records --file <file-id> --output tables.xlsx
```

`kb files` returns the document's status, a privacy summary with no names, and
file metadata: `id`, `kind`, `filename`, `content_type`, `size_bytes`,
`created_at`, `agent_readable` and `restricted`. `privacy` can be null, and a
document can have no conversion files. The summary reports the document and
output modes, clean/held state, findings and failure counts; a released
document can also carry `{at, by}` in `released`.

Use the file's **id** for `kb download --file`. The readable kinds are
`redacted_pdf` and `tables_xlsx`. The conversion report and privacy vault are
restricted: only a dashboard person with `knowledge_bases.manage_documents`
can read them. Listing their metadata gives no access to their contents.

Without `--file`, the instance's normal document download decides which PDF
is served. With `privacy_document` on, kit credentials receive the redacted
PDF. The chat, upload and ZIP downloads follow the same privacy rules.
Downloads write a new local file and refuse to overwrite an existing one.
An agent's output stays inside its solution folder, including over MCP.

The MCP tools are `kb_documents`, `kb_files` and `kb_download`; the last takes
`document`, `kb`, optional `file` (the file id), and required `output`.

## A document held for review

`status: held` means the redaction did not pass its checks. The document is
not indexed or readable, and downloads are refused. `kb documents` keeps that
status and marks `needs_person: true`. An upload waited to a held result exits
with code 5 and names the held documents; the kit keeps replacement documents
active rather than deactivating them for an unreadable replacement.

A person with `knowledge_bases.manage_documents` reviews and releases the
document in the Admin. Both the KB-document and conversation-upload release
operations are person-only. Neither an API key nor a personal access token
can release one, even in a person's terminal or with YOLO; the kit sends no
release request. KB orders continue waiting while a document is held.

## The solution's `read_document` tool

This is a built-in tool inside a Cavelon solution, separate from the kit's
MCP tools. Bind it as usual and let the instance supply its parameter schema.
Its optional `file` argument takes a **kind**, `redacted_pdf` or `tables_xlsx`,
or null for an ordinary text read. The fetched file becomes a document of the
conversation. The answer is `{ok, file, document_id, filename, size_bytes, ref}`;
the widget can offer it and `send_email` can attach it.

Descriptor mode (`max_chars: 0`) adds `files: [{file, filename, size_bytes}]`.
Text reads and file fetches of a held document return
`{ok: false, error: "held_for_privacy_review"}`. The vault and conversion report
are never returned. See the instance's `reference/builtin-tools` and
`reference/kb-management-api` pages with `cavelon docs get`.
