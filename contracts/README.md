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

On 2026-10-07 the OpenAPI was taken again from the instance's main branch,
from the reference its generator writes into the repository (`docs/openapi.json`,
generated from the code without running it), to add
`GET /api/v1/database-connectors/instance` (the dialects the instance runs and
its egress addresses). Trimmed, it differs from the snapshot only there and in
the connections' `ca_certificates` (subject, issuer, validity and fingerprint
per certificate). The instance's SQL Server support, with its refusal code
`write_privileges_unacknowledged`, was not on that branch yet, so the error
catalog and the capabilities stay as they were.

The tests switch features on in the fake server where a command needs them
(personal access tokens, the operations API, Sandboxes, Masterloop, archive
uploads, the database connector); the snapshot keeps the defaults.

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
