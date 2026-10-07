# Contract snapshots

The kit's tests run against what a Cavelon instance publishes, never against a
live instance. Each folder holds one instance version's published contracts,
and the fake server in `cli/test/` serves them.

## `cavelon/`

Recorded on 2026-10-04 from an instance with its default settings: every
optional feature off, rate limiting on, a tenant without settings of its own,
no licence entitlement, and an empty billing month. Refreshed on 2026-10-05
from an instance that publishes a test step's criterion shapes (judge criteria
and assertions by `type`), marks secret body fields (`x-cavelon-secret`), and
replaces a same-named document on upload (`replace_existing`); its
capabilities differ from the snapshot's only in settings, so that file stays. The chat
and deactivate operations were added the same day, trimmed from an instance
whose other operations match the snapshot. Later that day `include_tenant_wide`
was taken in on the export's query and the import request, from an instance
that also publishes newer trace, chat, document and readiness fields the
snapshot does not have yet, and then the package schema's `x-cavelon-scope:
tenant` on the six sections that instance marks tenant-wide (`tenant_settings`,
`model_registry`, `model_role_defaults`, `realtime_config`,
`telephony_config`, `kb_orders`); the rest of that schema matches the
snapshot.

Refreshed on 2026-10-06 from an instance build whose database connector was
not deployed anywhere yet, so its contracts were generated from that build's
code without running it: the package schema, the error catalog and the
capabilities from the functions its `/api/v1/meta` routes return, the OpenAPI
from its generator, and the docs index (with the new Database Connectors page)
from its docs corpus, all at default settings (the connector off,
`may_write_queries` false), then trimmed and scrubbed as below. The
capabilities' `limits` need a database to compute, so they stay as recorded on
2026-10-04, and `personal_access_tokens_enabled` and `operations_api_enabled`
stay off as recorded there. The same build also publishes other changes since
the last refresh (an agent's reasoning effort, knowledge base defaults, the
knowledge outcomes in the error catalog), which the snapshot now carries.

Later on 2026-10-06 the OpenAPI was generated again, the same way, from an
instance build whose `/meta/principal` publishes what a credential may really
do: the acting `tenant` (id, name, slug) and `needs_a_person` (the operations
the credential's permissions would allow that a person runs instead). Trimmed,
it differs from the snapshot only there and in `MetaLimits.tenant_quotas`,
which that build may leave out (null).

Refreshed on 2026-10-07 from the instance's main branch with its SQL Server
support, again without running it. The OpenAPI is the reference its generator
writes into the repository (`docs/openapi.json`). With
`GET /api/v1/database-connectors/instance` added to the list, the trimmed
snapshot gains that route (the dialects the instance runs and its egress
addresses). It also gains the connections' `ca_certificates`,
`write_privileges_acknowledged` and `query_enable_refusal`. The error catalog
and the package schema come from the functions behind `/meta/error-catalog`
and `/meta/package-schema`. Only the catalog's database connector codes are
taken in: `write_privileges_unacknowledged`, and the SQL Server wording of
`unavailable` and `forbidden_keyword`. The same build also refuses personal
access tokens on person-only operations (`person_only_operation`, and new
wording for `secret_needs_a_person` and `approval_needs_a_person`), which
changes what `secrets set` may do; that waits for the change that adapts the
kit to it. The build's `model_role_not_configured` waits with it. The package
schema is unchanged; it already named `mssql`. The capabilities differ only in settings
and stay. Of the docs, only the Database Connectors page is taken in (a
paragraph on testing an identity-scoped query as a Chat User). The index and
the other pages changed in parts the kit does not read, and stay as recorded.

On 2026-10-07 the error catalog took three entries from the instance's current
development build, as its catalog defines them: the new wording of
`secret_needs_a_person` (a personal access token cannot set or delete a secret
either) and `approval_needs_a_person`, and the new `person_only_operation`,
from the instance build that refuses every token and key on what a person runs.
The rest of the catalog stays as recorded.

Later on 2026-10-07 the snapshot was refreshed from the instance's next
build, which is not released or deployed anywhere yet, again without running
it: the change that checks a person's confirmation of a personal access
token's guarded change on the server. The OpenAPI is the reference that build's
generator writes (`docs/openapi.json`), trimmed with `POST /api/v1/confirmations`
added to the list; against the snapshot it differs only in that route, its
`Confirmation*` schemas, `MetaCapabilities.confirmations`, and
`x-cavelon-confirmation`, `x-cavelon-confirmation-when` and a `428` response on
the six guarded operations. The capabilities gain `confirmations` as that
build's `/meta/capabilities` returns it at its default settings (`enforced`
true), and the error catalog its four `confirmation` codes, as its
`/meta/error-catalog` defines them (`confirmation_required`,
`confirmation_invalid`, `confirmation_not_needed`,
`confirmation_needs_a_token`). The rest stays as recorded. Until that build is
released, a deployed instance publishes none of this; the fake server plays
both (`confirmations: null` is the instance without it).

Later on 2026-10-07 the snapshot took in the instance's SQL Server
stored-procedure queries, from its main branch, again without running it. The
OpenAPI is the reference its generator writes (`docs/openapi.json`), trimmed
the same way; against the snapshot it differs only in three fields, which are
taken in (`DatabaseConnectionResponse.procedure_call_refusal`,
`DatabaseConnectionTestResponse.procedure_findings` and
`DatabaseQueryTestRunResponse.notice`), and in the confirmation route and its
fields, which that branch does not carry yet and which stay as recorded. The
error catalog, from the function behind `/meta/error-catalog`, takes in only
the database connector's changes: the new `procedure_call_form`,
`write_privileges_block_procedure`, `procedure_definition_unreadable` and
`procedure_definition_writes`, and the new wording of `not_select`,
`query_failed` and `write_privileges_unacknowledged`. The package schema takes
in only the new description of a query's `sql_text`, which names the
procedure call. The Database Connectors page did not change.

Later on 2026-10-07 the package schema and error catalog took in workflow
Tool Call database queries from the instance's main branch, without running
it. They were generated from the functions behind `/meta/package-schema`
(`package_schema("v3")`) and `/meta/error-catalog` (`error_catalog()`), using
that branch's source and existing Python environment. Only the
`NodeConfig_tool_call` and `DatabaseQueryNodeOutput` definitions and the
`tool_call_database_query_missing` catalog entry are taken in, then scrubbed
as below; unrelated changes stay as recorded. The output publishes both the
query's column/row result and its `{error, message}` failure. No new API
operation is called by the kit, so the operation list and OpenAPI stay.

The tests switch features on in the fake server where a command needs them
(personal access tokens, the operations API, Sandboxes, Masterloop, archive
uploads, the database connector); the snapshot keeps the defaults.

On 2026-10-07 the snapshot took connection management, login scripts and the
schema explorer from the published development build, without running it.
The OpenAPI comes from the reference its generator writes (`docs/openapi.json`),
trimmed to the six added operations and their referenced schemas. Existing
operations and component shapes stay as recorded. Create and update publish
password as optional, secret and person-only; this build's login-script
response publishes only `read_only`, and its connection response does not yet
publish `allows_writes`. The two Database Connectors/Setup pages come from
the docs corpus's renderer; only their index entries change. The catalog's
generator was checked for connection-specific additions and none were needed.
Capabilities, package schema, unrelated pages and all defaults stay as recorded.

| File | Source |
|---|---|
| `openapi.json` | `GET /openapi.json`, trimmed by `cli/scripts/trim-openapi.mjs` to the operations listed in [`kit-operations.json`](kit-operations.json) and the components they reference, without prose descriptions |
| `meta-capabilities.json` | `GET /api/v1/meta/capabilities`: the instance's version, features and contract versions, and `limits` with each limit's value, source, who changes it and how |
| `meta-error-catalog.json` | `GET /api/v1/meta/error-catalog`: every rule and API error code with its message, hint and docs page |
| `meta-package-schema-v3.json` | `GET /api/v1/meta/package-schema?version=v3`: the JSON Schema of a solution package |
| `docs/llms.txt` | `GET /llms.txt`, with the base URL `https://cavelon.example.com` and the version `meta-capabilities.json` reports |
| `docs/<section>__<page>.md` | `GET /api/v1/docs/<section>/<page>.md`: the pages the kit's commands and skills point to |

## Refreshing

1. Fetch the bodies above from an instance at its default settings, with a
   personal access token, and save each under the file name in the table
   (`openapi.json` anywhere outside the repository, as it is the whole API).
   `cavelon` caches the first four under
   `<cache>/<instance>/<version>/` whenever a command reads them (`<cache>` is
   `~/.cache/cavelon` by default, or `CAVELON_CACHE_DIR`), the capabilities as
   `capabilities.<hash>.json`, once per tenant.
2. Trim the OpenAPI and clean the texts:

   ```bash
   cd cli
   node scripts/trim-openapi.mjs /path/to/openapi.json
   node scripts/scrub-contracts.mjs                 # --rename <old>=Cavelon for an older product name in the texts
   ```

   `trim-openapi.mjs` stops when a listed operation is no longer published.
   `scrub-contracts.mjs` drops developer notes the texts may carry: issue
   references, and a rule's explanation past its first paragraph. Where the
   instance was not at its default settings, `--rename` takes its texts back
   to the defaults: `--rename <its base URL>=` makes the error catalog's docs
   links relative, and a branded product name or a version can be renamed the
   same way (rename whole words, so `CAVELON_TENANT` stays).
3. Update the date above, run `npm test` in `cli/`, and fix what the new
   contracts break.

A command that calls a new operation adds it to `kit-operations.json` in the
same change, then trims again. `contract.test.ts` fails when the snapshot holds
an operation the list does not name, or misses one it does.

When the kit supports several instance versions, each gets its own folder
here, and the contract tests run against every one.

## `offline-bundle-manifest.schema.json`

Not a snapshot but a contract the kit publishes: the schema of `manifest.json`
in the offline bundle each release carries (`docs/offline-bundle.md`), which an
instance reads to choose and verify the bundle that fits it.
`packaging/bundle/build-bundle.mjs` writes the manifest and
`cli/test/offline-bundle.test.ts` validates it against this schema. A change
that a reader of the current `format` cannot follow raises `format`.

## `clients/`

The schemas the coding agents publish for their plugin formats, which
`cli/test/plugin-packages.test.ts` checks the release's packages against:

- `agent-plugins-1.0.0/plugin.schema.json` and `mcp.schema.json`: the
  [Agent Plugins](https://agent-plugins.org) 1.0.0 manifest and MCP file, which
  Cursor, VS Code with GitHub Copilot, Copilot CLI and Kiro read. Downloaded on
  2026-10-07 from `https://agent-plugins.org/schemas/1.0.0/`.

Gemini CLI publishes no schema for `gemini-extension.json`; the test holds the
rules its loader applies, and CI runs `gemini extensions validate`. CI also
compares the kept schemas with the published ones and warns when they differ
(`.github/scripts/test-plugin-packages.sh`); refresh them by downloading the
same URLs again.
