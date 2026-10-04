# Troubleshooting

When a command fails, `cavelon` prints what went wrong and a hint, and exits
with a code that says what kind of failure it was:

```text
error: The personal access token "laptop" was not created with "may activate", so it cannot activate solutions.
hint: A person activates the solution in the Admin, or creates a token with "may activate" on /account/access-tokens.
```

With `--json`, the same error is one JSON document, carrying the instance's
own error code where it sent one:

```json
{"error":{"code":"token_activation_refused","message":"…","hint":"…","exit_code":7}}
```

Two commands help with any code:

- **`cavelon explain <code>`** looks the code up in your instance's error
  catalog: what it means, how to fix it, and the docs page. It also explains
  the test-case statuses that are neither pass nor fail
  (`calibration_required`, `pending_review`, `not_run`, `not_evaluated` and
  `skip`): what each means and what to do next.
- **`cavelon status`** shows the instance, credential, tenant and solution this
  folder uses, the solution's state (draft or active, ready to activate or what
  blocks it, the latest test run), open previews, running operations, and why
  the quotas cannot be read when the token may not read them. Offline, the
  version it shows is the cached one, marked with when it was read.

## Exit codes

Scripts, CI jobs and agents may branch on these; a code never changes its
meaning.

| Code | Meaning | What to do |
|---|---|---|
| 0 | ok | |
| 1 | anything else: not found, an operation failed or was cancelled, a test case failed, a test run measured nothing comparable | read the message; for a test run, `cavelon trace <run>` |
| 2 | usage: unknown command or option, a missing argument, no instance chosen | `cavelon <command> --help` |
| 3 | validation failed: the arguments, files or body do not match the instance's schema, or the instance refused them (400, 422) | fix what the findings name; `cavelon explain <code>` |
| 4 | conflict or stale preview (409, 412) | preview or read again, then repeat |
| 5 | needs a person (`needs_action`): an approval, a review, test answers that wait for a manual verdict or a knowledge base or value a case needs | the message gives the reason and the Admin link |
| 6 | timed out; the work goes on | run the printed `cavelon wait …` again to resume |
| 7 | not authorised: no token, or the instance refused it (401, 403) | see [Logging in and permissions](#logging-in-and-permissions) |
| 8 | server or network error (5xx, 429, unreachable, request timeout) | retry; see [Network](#network) |

## Choosing an instance and tenant

| Code | Exit | Cause and fix |
|---|---|---|
| `no_instance` | 2 | No instance chosen. Log in (`cavelon login --instance <url>`), set `CAVELON_URL`, or work in a folder with `cavelon.yaml`. |
| `tenant_required` | 2 | No tenant is chosen and the token reaches several, every one (an operator's token) or none (Platform mode). Run `cavelon use` and choose one by number or name, or pass `--tenant <name, slug or id>`. Without a terminal, the error lists one ready `cavelon use <tenant>` line per tenant (`details.tenants` with `--json`); after `login`, the token is already stored. An older instance that refuses the token without a tenant ("does not work in Platform mode") names none of its tenants: pass the tenant's id, `--tenant <tenant-id>` (an operator copies it in Platform › Tenants), or use a token limited to one tenant. |
| `tenant_not_found` | 1 | The tenant named by `--tenant`, `CAVELON_TENANT`, `cavelon.yaml` or `cavelon use` is not one your token reaches. The error names the closest tenants with the `cavelon use` line for each (`details.tenants` with `--json`); `cavelon tenant list` shows the tenants your token reaches with name, slug and id, and an operator's token that reaches every tenant finds one with `cavelon tenant list --search <part of the name>`. On an older instance a member's token finds a slug only where it may view the tenant's settings: use the tenant's name or id there. |
| `no_tenant_reached` | 7 | The token reaches no tenant, so `login` stored nothing. Create a token for the tenant you work in on `/account/access-tokens` (or ask a tenant administrator to add you to a tenant), then run `cavelon login` again. |
| `foreign_url` | 2 | A request would have gone to another host than the instance; `cavelon` never sends the token elsewhere. |
| `usage` "Refusing to send a token over plain http" | 2 | Use `https://`. For a test instance on a private network, set `CAVELON_ALLOW_HTTP=1`; `localhost` is always allowed. |

`cavelon whoami` says which instance and tenant a command uses, and where each
came from. The order is in [Concepts](concepts.md#tenant).

## Logging in and permissions

| Code | Exit | Cause and fix |
|---|---|---|
| `not_logged_in` | 7 | No token for this instance. A person runs `cavelon login --instance <url>`, or sets `CAVELON_URL` and `CAVELON_TOKEN`. |
| `personal_access_tokens_disabled` | 7 | The instance has personal access tokens turned off, so it refuses every `cvpat_` token. Its operator turns them on (`PERSONAL_ACCESS_TOKENS_ENABLED`). Until then, a tenant API key (`cbp_…`) works for the commands that accept one. |
| `unauthorized` (401) | 7 | The token is missing, expired or revoked. Create a new one on `/account/access-tokens` and run `cavelon login` again. `cavelon whoami` shows when a token expires and warns seven days before. |
| `forbidden` (403) | 7 | The token does not reach this: another tenant, or a permission your role or the token's ceiling lacks. Check the tenant with `cavelon whoami`; the message names the permission where the instance publishes it. On a platform route (creating tenants, the platform's settings) the tenant does not matter: the hint says the route needs a token that allows Platform mode, and `cavelon whoami` shows whether this one does. |
| `token_activation_refused` | 7 | The token was created without **May activate**. A person activates in the Admin, or creates a token that may. |
| `secret_needs_a_person` | 7 | Secrets are set by a person with a personal access token, never with a tenant API key. |
| `api_key_cannot_create_tenants` | 7 | Creating a tenant needs a personal access token in Platform mode. |
| `platform_mode_not_allowed` | 7 | `tenant create` asked the instance first: this personal access token may not enter Platform mode (the message names its ceiling), so nothing was sent. Create a token with **Allow Platform mode** and a platform ceiling, owned by someone with `tenants.manage`, and log in with it; or create the tenant in the Admin. |
| `permission_missing` | 7 | `tenant create` asked the instance first: the token enters Platform mode, but without `tenants.manage`, so nothing was sent. |
| `platform_role_required` | 7 | An operator's change needs a personal access token that allows Platform mode, of the role the change names. See [Limits](limits.md#operators-changes). |
| `limit_changed_by_operator` | 7 | Only the instance operator changes this limit; the message names the setting. |
| `operation_for_a_person` | 2 | Over MCP, `api` does not send an operation the instance marks for a person only (`x-cavelon-person-only`; the message has its reason), even with `confirm`. On an instance that marks none, that is an operation that changes a secret, creates or revokes a credential or decides an approval. A person does it: `cavelon secrets set <name>` in their terminal, or in Cavelon. |
| `path_outside_solution` | 2 | Over MCP, a tool reads and writes files only inside the solution folder (the folder of `cavelon.yaml`, or the one the server started in), after following symlinks. Move the file into the folder, or run the command in your terminal. |
| `path_in_kit_directory` | 2 | Over MCP, no tool reads or writes in `cavelon`'s own config or cache directory, which hold the stored token and the instance's contracts. |

`CAVELON_TOKEN` is used only together with `CAVELON_URL`, and only for that
instance. If you set `CAVELON_TOKEN` without `CAVELON_URL`, `cavelon` ignores it
and says so.

**`login` cannot store the token.** On Linux without a Secret Service (a
server, a container, WSL), `cavelon` keeps the token in a file only you can
read and says so. To always use the file, set `CAVELON_CREDENTIAL_STORE=file`.

**`login` waits for input in an agent's chat.** An agent's shell has no
terminal to type the token into. Run `login` in a terminal of your own, or pipe
the token with `--token-stdin`.

## Waiting for work

| Code | Exit | Cause and fix |
|---|---|---|
| `operations_unavailable` | 1 | The instance does not offer the operations API, so `wait`, `watch` and `--wait` cannot follow work. The work itself was started. Its operator turns the API on (`OPERATIONS_API_ENABLED`). |
| `operation_not_found` | 1 | No such operation in this tenant. Operation ids are per tenant; check `cavelon whoami`. |
| timed out | 6 | The timeout came first; the work goes on. Run the printed `cavelon wait <ids>` again, with a longer `--timeout` if you like. |
| `needs_action` | 5 | The work waits for a person, such as an approval. The message has the reason and the Admin link. |

**"waiting for run capacity".** Every run slot of the tenant or the instance is
taken, so the run waits in the queue and starts when one is free. This is not
an error: `cavelon` keeps waiting within the timeout. If it happens often, ask
the instance operator to raise the run caps; `cavelon limits` shows them and
where they are set.

**`run_capacity_busy` or `model_endpoint_busy`.** A run or a call was refused
because all run slots, or all of a model endpoint's slots, were in use. Retry
later. `cavelon explain run_capacity_busy` names the limit to raise and who
can. See [Limits](limits.md#run-capacity).

## Approvals

A person decides an approval, in the Admin or with their own personal access
token; neither `cavelon` nor a coding agent decides one. When an Approval node
says who may decide, the instance refuses anyone else before anything about
the run changes, approving and rejecting alike:

| Code | Exit | Cause and fix |
|---|---|---|
| `approval_approver_rule_not_met` (403) | 7 | The node's `approvers` name the tenant roles and access groups that may decide this request (for a tiered rule, the tier its amount chose), and you hold none of them. Someone who does decides it. Your access groups are those of the chat user with your verified email in this workspace; a tenant API key matches no approver rule. |
| `approval_requester_cannot_decide` (403) | 7 | The node sets `forbid_self_approval`, and you requested this approval: the conversation that started the run was yours. Another person who may decide it does. |

`cavelon explain <code>` gives your instance's own wording for both. To check
who may decide before you test, read the node's `approvers` in
`package/registry_entities.yaml`.

## Validation and packages

| Code | Exit | Cause and fix |
|---|---|---|
| `package_schema_invalid` | 3 | A package file does not match the instance's package schema. Each finding names the file, line and path. |
| `package_version_unsupported` | 3 | The instance does not accept the package version in `cavelon.yaml` and `package/manifest.yaml`. `cavelon status --json` lists the accepted versions; `cavelon pull` writes a current package. |
| `knowledge_base_without_search_tool` | 0 (a warning) | An agent is given a knowledge base, by a skill or on a tool assignment, but no search tool reaches it, so it answers without it. Add `- tool_slug: search_documents` to the `tool_assignments` of that skill or of the agent. |
| `package_duplicate_key` | 3 | Two entries of one section have the same slug (or name, for a knowledge base); the import would keep one. The finding names both places. |
| `package_reference_missing` | 3 | An agent hands off to an agent that is not in the package. The finding suggests the closest slug. |
| `package_reference_unknown` | 0 (a warning) | A skill, tool, knowledge base or solution is named that is neither in the package nor among what the tenant held at the last pull (`.cavelon/inventory.json`). Fix the name (the finding suggests the closest one), or run `cavelon pull` if it was created since. Without that list, only the package is checked. |
| `package_field_unknown` | 0 (a warning) | A field the package schema does not have; the import ignores it. The finding suggests the field you probably meant. A required field under another name is reported once, as the missing field, with the suggestion. |
| `package_model_unknown` | 0 (a warning) | An agent's `llm_model` is not in the tenant's model list as `pull` or `models list` last read it. An empty Model Registry is not checked: the instance's defaults serve the agents. |
| `package_file_invalid` | 3 | A package file is not valid YAML or JSON (the finding names the line), or it is a symlink to a file outside the solution folder or to no file. A link inside the solution folder is read as the file it leads to. |
| `project_file_invalid`, `env_file_invalid` | 3 | `cavelon.yaml` or `env/<name>.yaml` is not valid YAML or has a wrong value. |
| `project_file_has_secret` | 3 | `cavelon.yaml` contains something that looks like a token. Remove it, revoke the token, and use `cavelon login` or `CAVELON_TOKEN`. |
| `no_solution` | 2 | The command needs a solution folder: run it in a folder with `cavelon.yaml`, or `cavelon init` first. |
| `solution_not_found` | 1 | The solution named by `--harness`, `cavelon.yaml` or an env file does not exist in this tenant, by name, slug or id. The error names the closest solutions (`details.candidates` with `--json`); `cavelon harness list` shows those that do, with name, slug and id. |

A finding with a code of the instance's rules (such as a graph rule) is
explained by `cavelon explain <code>`. Warnings never fail `validate`;
errors exit 3.

On a development build of the instance, `validate` may report a field or
section the instance has just gained as unknown: the build keeps its version
while its schema changes, and `validate` reads the schema again only once its
cached copy is a minute old (`CAVELON_CONTRACT_TTL_SECONDS`), or when the
instance's ETag says it changed. `cavelon validate --verbose` names the copy it
used: cached or read now, when, and its hash.

## Preview and apply

| Code | Exit | Cause and fix |
|---|---|---|
| `import_preview_stale` | 4 | The solution changed on the instance after the preview. Nothing was imported. Run `cavelon apply` again and confirm the new preview. |
| `package_requirements_changed` | 4 | The import's own check found something the preview did not; each blocker is listed. Nothing was imported. Fix the blockers and preview again. |
| `preview_unknown` | 2 | No open preview with that id in this folder. `cavelon status` lists the open ones. |
| `preview_other_tenant`, `preview_other_instance` | 4 | The preview was made for another tenant or instance than the one this command uses. Preview again here. |
| `uncommitted_changes` | 4 | `pull` would overwrite package files with uncommitted changes. Outside a git repository: it would overwrite or remove a package file that changed since the last pull, such as your edit or a test suite you have not applied. A file as the last pull or confirmed apply left it is never listed. The files are listed. Commit them, apply them, or use `--force` to discard them. |
| `package_file_outside` | 4 | `pull` or `init --from` would write a package file that is a symlink to a file outside the solution folder. Nothing was written. Move the file into the solution folder, or replace the link with the file. |
| `package_files_differ` | 4 | `init --from` would change or remove package files that hold something else. The files are listed; `--force` replaces them. |

## Network

| Code | Exit | Cause and fix |
|---|---|---|
| `network_error` | 8 | The instance could not be reached, or its answer broke off. Check the URL, your VPN and proxy. |
| `request_timeout` | 8 | A request, or reading its answer, took longer than 30 seconds. Retry; `CAVELON_HTTP_TIMEOUT_MS` raises the limit. |
| `rate_limited` (429) | 8 | Too many requests; wait a moment and retry. |
| `server_error` (5xx) | 8 | The instance failed. Retry; if it persists, tell its operator. |
| `unexpected_redirect` | 8 | The instance answered with a redirect, often a sign-in page in front of it or a wrong URL. Check the URL `cavelon whoami` uses. |

A command that starts work (`loop start`, `loop pause`, `loop resume`,
`sandbox refresh`, `artifacts export`) may have reached the instance before
the error. Its hint names the `Idempotency-Key` it sent: retry with
`--idempotency-key <key>`, and the instance does not do it twice.

Behind a proxy or a TLS-inspecting firewall, see
[Installation](installation.md#behind-a-proxy).

## Sandboxes and loops

| Code | Exit | Cause and fix |
|---|---|---|
| `sandbox_capability_unavailable`, `sandbox_workspace_refresh_unavailable`, `sandbox_validation_receipt_unavailable` | 3 | The Sandbox's mode does not offer this. An isolated container takes `seed` and `artifacts export`; a customer VM takes `refresh` and `cat`. |
| `sandbox_harness_not_allowed` | 7 | The solution is not allowed to use this Sandbox. Name another with `--harness`, or allow it in the Sandbox's access settings. |
| `loop_resume_review_required` | 5 | The pause needs a review. Run the printed `cavelon loop resume <run> --reason <reason>` after reviewing it. |
| `loop_not_resumable` | 4 | The loop cannot be resumed; the message says what to do instead (cancel, start again). |
| `loop_state_conflict` | 4 | The loop changed between reading and acting. Read it again and repeat. |

## Still stuck

- Run the command with `--json` and read the whole error, including `details`.
- `cavelon docs search <words>` searches your instance's documentation. The
  docs are in English: German words for the core concepts (Wissensbasis,
  testen, Standard) are looked up in English, and other questions do best in
  English words. When nothing matches, it says so; `cavelon docs get index`
  lists every page.
- Report a problem with the kit on
  [GitHub issues](https://github.com/goodguys-gmbh/cavelon-dev-kit/issues),
  with the command, its output and `cavelon --version`. Leave out tokens,
  secrets and customer data. A security problem goes through
  [SECURITY.md](../SECURITY.md) instead.
