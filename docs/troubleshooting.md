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
| 4 | conflict or stale preview (409, 412): one that is expired, superseded by another import, already imported or discarded; a confirm token of another change, a draft named as the default route | preview or read again, then repeat |
| 5 | needs a person (`needs_action`): an approval, a review, test answers that wait for a manual verdict or a knowledge base or value a case needs; run by a coding agent, an operation or a secret field the instance keeps for a person, or a `--confirm` without its preview's token | the message gives the reason, the Admin link or the command a person runs |
| 6 | timed out; the work goes on | run the printed `cavelon wait …` again to resume |
| 7 | not authorised: no token, or the instance refused it (401, 403) | see [Logging in and permissions](#logging-in-and-permissions) |
| 8 | server or network error (5xx, 429, unreachable, request timeout) | retry; see [Network](#network) |

## Choosing an instance and tenant

| Code | Exit | Cause and fix |
|---|---|---|
| `no_instance` | 2 | No instance chosen. Log in (`cavelon login --instance <url>`), set `CAVELON_URL`, or work in a folder with `cavelon.yaml`. |
| `tenant_required` | 2 | No tenant is chosen and the token reaches several, every one (an operator's token) or none (Platform mode). Run `cavelon use` and choose one by number or name, or pass `--tenant <name, slug or id>`. Without a terminal, the error lists one ready `cavelon use <tenant>` line per tenant (`details.tenants` with `--json`); after `login`, the token is already stored. An older instance that refuses the token without a tenant ("does not work in Platform mode") names none of its tenants: pass the tenant's id, `--tenant <tenant-id>` (an operator copies it in Platform › Tenants), or use a token limited to one tenant. |
| `tenant_mismatch` | 2 | A tenant API key acts only in its own tenant, and `--tenant`, `CAVELON_TENANT`, the env file or `cavelon.yaml` names another; the error names both (`details.named`, `details.key_tenant`). Nothing was sent there. Use a key of the tenant you name in `CAVELON_TOKEN`, name the key's tenant, or leave the tenant out where the key is meant. |
| `tenant_moved` | 4 | A change was refused (403 or 404) in the tenant a remembered slug named, and the slug now names another tenant: it was renamed or reused. Nothing was changed. Run the command again; it acts in the tenant the slug names now, and a change previews there first. |
| `tenant_not_found` | 1 | The tenant named by `--tenant`, `CAVELON_TENANT`, `cavelon.yaml` or `cavelon use` is not one your token reaches. The error names the closest tenants with the `cavelon use` line for each (`details.tenants` with `--json`); `cavelon tenant list` shows the tenants your token reaches with name, slug and id, and an operator's token that reaches every tenant finds one with `cavelon tenant list --search <part of the name>`. On an older instance a member's token finds a slug only where it may view the tenant's settings: use the tenant's name or id there. |
| `no_tenant_reached` | 7 | The token reaches no tenant, so `login` stored nothing. Create a token for the tenant you work in on `/account/access-tokens` (or ask a tenant administrator to add you to a tenant), then run `cavelon login` again. |
| `foreign_url` | 2 | A request would have gone to another host than the instance; `cavelon` never sends the token elsewhere. |
| `usage` "Refusing to send a token over plain http" | 2 | Use `https://`. For a test instance on a private network, set `CAVELON_ALLOW_HTTP=1`; `localhost` is always allowed. |

`cavelon whoami` says which instance and tenant a command uses, and where each
came from. The order is in [Concepts](concepts.md#tenant).

## Login says it needs a person

The kit returns `operation_for_a_person` (exit 5) for token login in
a recognized agent shell, including `--token-stdin`. It reads no token and
keeps the stored login. Open a separate terminal application, run `cavelon login`
yourself and then return to the agent. See [Log in](getting-started.md#2-log-in).

## A root MCP session cannot find a child solution's environment or preview

In a multi-solution repository, `No env/test.yaml in this solution` or
`preview_unknown` can mean the MCP server is reading the root folder.
`harness` selects the solution on the instance; it does not choose local files.
Kit 0.1.16 adds `solution_dir`: pass the child folder, such as
`solutions/review`, on the preview, confirmation and subsequent MCP calls.
See [MCP folder selection](mcp.md#several-solutions-in-one-repository).
On 0.1.15, start a separate MCP session in the child solution, or run the
previewed command in your own terminal from that folder. The agent still
cannot answer a guarded-change confirmation on your behalf.

## Qwen setup reports a managed binding or MCP policy

Qwen setup leaves operator settings, MCP allow/exclude policies and
personal Cavelon entries unchanged. Review the named file with the person or
operator. `QWEN_HOME` is the configuration directory itself; `QWEN_RUNTIME_DIR`
does not move settings or skills. Use the same overrides for setup and the
client, then restart Qwen and check its `/mcp` and `/skills` lists. See
[Qwen Code](install/qwen-code.md#check).

## A native adapter's files or references were edited

OpenCode/Pi, Kilo and OMP setup record hashes of the native assets and disabled
Cavelon MCP entry, plus exact plugin/extension references. Update, check and
removal refuse an edited binding, asset or reference, and duplicate path
aliases. This preserves personal configuration and avoids removing an asset
still used by a surviving reference.

Review the recorded `cavelon/installation.json` and the changes to its named
files. Restore only the kit-owned bytes if the edit was accidental. For an
intentional custom integration, review and remove its Cavelon references and
assets yourself, keeping unrelated settings. Do not re-enable the duplicate
built-in entry alongside the native adapter. If a config-directory override
changed, remove the old recorded installation before setting up the new one.
See [OpenCode](install/opencode.md#update) or [Pi](install/pi.md#update).

If setup reports an existing `cavelon.lock`, another installer may still be
working. Inspect the lock's process ID and wait for that process to finish.
After an interrupted run, remove only that stale lock once you have confirmed
the installer is no longer running, then repeat setup.

## Logging in and permissions

| Code | Exit | Cause and fix |
|---|---|---|
| `not_logged_in` | 7 | No token for this instance. A person runs `cavelon login --instance <url>`, or sets `CAVELON_URL` and `CAVELON_TOKEN`. |
| `personal_access_tokens_disabled` | 7 | The instance has personal access tokens turned off, so it refuses every `cvpat_` token. Its operator turns them on (`PERSONAL_ACCESS_TOKENS_ENABLED`). Until then, a tenant API key (`cbp_…`) works for the commands that accept one. |
| `unauthorized` (401) | 7 | The token is missing, expired or revoked. Create a new one on `/account/access-tokens` and run `cavelon login` again. `cavelon whoami` shows when a token expires and warns seven days before. |
| `forbidden` (403) | 7 | The credential does not reach this: another tenant, or a permission it lacks. The hint names the permission, from the refusal or from what the instance publishes about the credential (`details.permissions`), and says it by the credential's kind: a personal access token acts with the lesser of its owner's role and its ceiling; a tenant API key only with what its scopes grant, so a tenant administrator issues a key that may, or a person does it. An operation the instance keeps for a person says so, with the instance's reason. `cavelon whoami` lists the credential's permissions and scopes. On a platform route (creating tenants, the platform's settings) the tenant does not matter: the hint says the route needs a token that allows Platform mode, and `cavelon whoami` shows whether this one does. |
| `token_activation_refused` | 7 | The token was created without **May activate**. A person activates in the Admin, or creates a token that may. |
| `default_route_deactivate` | 5 | `cavelon deactivate` refused the tenant's default route; nothing was sent. Ask the person which solution should answer in the tenant's chat and widget instead, make it the default with `cavelon harness default <solution>` (previews first), then deactivate. |
| `secret_needs_a_person` | 5 or 7 | Secrets are set by a person, never with a tenant API key. Where the instance lets only a person signed in to the Admin set one, no token sets it either (5): set it in the Admin under Settings › Secrets. On an older instance a key is refused with 7, and a person sets it with their personal access token. |
| `import_needs_a_person` | 5 | The instance lists imports in this credential's `needs_a_person`. `apply` still previews but prints no confirm command; `apply --confirm` refuses before sending. A person imports in the Admin or with their own personal access token. Older instances that publish no restriction leave the decision to the server. |
| `key_needs_a_person` (conditional identity tests) | 5 or 7 | With a matching published `needs_a_person_when`, `db test-run` refuses an API key on a query with `end_user.*` parameters, and `test run --as-chat-user` refuses the key's reader choice before execution (5). A person chooses the identity in the Admin or with their own personal access token. Ordinary query tests and runs using a suite's saved reader remain usable. Older instances and generic API requests leave the decision to the server, whose 403 keeps exit 7. |
| `permission_missing` (variables) | 7 | `variables set` or `variables delete` was refused: setting a variable needs the permission a secret needs (`settings.secrets.manage` or `settings.manage`), which a Builder's role does not hold. A tenant Owner sets it, in the Admin under Settings › Variables or with their own token; `cavelon whoami` says "may set variables". |
| `api_key_cannot_create_tenants` | 7 | Creating a tenant needs a personal access token in Platform mode. |
| `platform_mode_not_allowed` | 7 | `tenant create` asked the instance first: this personal access token may not enter Platform mode (the message names its ceiling), so nothing was sent. Create a token with **Allow Platform mode** and a platform ceiling, owned by someone with `tenants.manage`, and log in with it; or create the tenant in the Admin. |
| `permission_missing` | 7 | `tenant create` asked the instance first: the token enters Platform mode, but without `tenants.manage`, so nothing was sent. |
| `platform_role_required` | 7 | An operator's change needs a personal access token that allows Platform mode, of the role the change names. See [Limits](limits.md#operators-changes). |
| `limit_changed_by_operator` | 7 | Only the instance operator changes this limit; the message names the setting. |
| `operation_for_a_person` | 2 | Over MCP, `api` does not send an operation the instance marks for a person only (`x-cavelon-person-only`; the message has its reason), even with `confirm`. On an instance that marks none, that is an operation that changes a secret, creates or revokes a credential or decides an approval. A person does it: `cavelon secrets set <name>` in their terminal, or in Cavelon. |
| `path_outside_solution` | 2 | A solution-owned file or directory resolves outside the solution, including a new file below a linked directory. This also guards CLI-generated files, environments and `.cavelon/` state. Move it inside the solution or use an internal link. MCP input/output paths remain confined to the selected solution. |
| `path_in_kit_directory` | 2 | The path reaches or overlaps `cavelon`'s config or cache directory, which hold the login and contracts. Keep generated solution paths and links separate from those directories, including when the private directories are inside the workspace. |
| `confirm_needs_person` | 5 | A coding agent confirmed, with its preview's token, a change only a person may confirm (it reaches live traffic or the whole tenant, or cannot be taken back), from its shell or over MCP from a client that cannot ask the person. Nothing was changed. The person runs the command in `details.person_command` in their own terminal (not with `!` in the agent). |
| `confirmation_required` | 5 | The instance refused a personal access token's change it guards (`x-cavelon-confirmation`) without an id bound to the token, tenant and exact request. Nothing was changed. `cavelon` asks for the id only after the person approved: in their own terminal with `--confirm`, or in the MCP client's dialog. Asking the person is the kit's job; the instance does not verify their answer. The person confirms it there, or makes the change in the Admin. An older `cavelon` sends no id: update it. |
| `confirmation_invalid` | 5 | The confirmation id the change carried is unknown, expired (it lasts 10 minutes), already used, or names another change, token or tenant (`details.reason`). Nothing was changed. Run the command again: it previews the change, and after the person's yes `cavelon` asks for a new one. |
| `confirm_declined` | 5 | Over MCP, the agent's client asked the person to approve the change, and they declined or did not answer within 10 minutes. Nothing was changed. Ask the person; with their yes, confirm again with the same token, or they run the command in their own terminal. |
| `confirm_token_required` | 2 | Over MCP, a tool that confirms a change (`api`, `limits_set`, `harness_default`, …) was called with `confirm: true`. It confirms only with the `confirm_token` its preview returned: call it without `confirm`, show the preview, then call it again with the same arguments and that token. A token of another change returns the new preview with `token_mismatch` and exit code 4. |

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
| `package_schema_invalid` | 3 | A package file does not match the instance's package schema. Each finding names the file, line and path, and its hint the `cavelon schema <path>` that shows the fields there (`cavelon schema agents.handoffs`). Where a value can take several shapes (a test step's criterion is a text, a judge criterion or an assertion by `type`), only what the closest shape says is reported; a `type` that names no shape (`answerd_by`) is one finding with the closest type (`did you mean "answered_by"?`). A required field under another name points at the line of the misspelt field. |
| `package_version_unsupported` | 3 | The instance does not accept the package version in `cavelon.yaml` and `package/manifest.yaml`. `cavelon status --json` lists the accepted versions; `cavelon pull` writes a current package. |
| `knowledge_base_without_search_tool` | 0 (a warning) | An agent is given a knowledge base, by a skill or on a tool assignment, but no search tool reaches it, so it answers without it. Add `- tool_slug: search_documents` to the `tool_assignments` of that skill or of the agent. |
| `package_duplicate_key` | 3 | Two entries of one section have the same slug (or name, for a knowledge base); the import would keep one. The finding names both places. |
| `package_reference_missing` | 3 | An agent hands off to an agent that is not in the package, or a test step's `answered_by` or `handoff_to` assertion names one. The finding suggests the closest slug. |
| `package_reference_unknown` | 0 (a warning) | A skill, tool, knowledge base or solution is named (by an agent, a skill, or a test step's `tool_called`, `tool_not_called` or `min_results` assertion) that is neither in the package nor among what the tenant held at the last pull (`.cavelon/inventory.json`). Fix the name (the finding suggests the closest one), or run `cavelon pull` if it was created since. The import preview blocks such a reference unless it exists by then, so `validate` does not say "Valid", and `--strict` fails. Where no command has read the tenant's list yet, `validate` reads it, unless `--offline`; then it says which check it skipped (`Not checked: …`, `skipped` in `--json`). |
| `package_field_unknown` | 0 (a warning) | A field the package schema does not have; the import ignores it. The finding suggests the field you probably meant. A required field under another name is reported once, as the missing field, with the suggestion. |
| `package_model_unknown` | 0 (a warning) | An agent's `llm_model` is not in the tenant's model list as `pull`, `models list` or `validate` last read it. The import preview blocks it, so `validate` does not say "Valid", and `--strict` fails. An empty Model Registry is not checked: the instance's defaults serve the agents. |
| `solution_slug_mismatch` | 0 (a warning) | The package names another solution than `cavelon.yaml`: `package/harnesses.yaml` holds no entry of its slug, or (in a package without harnesses) an agent's or suite's `harness_slug` names another. Typical after copying an example under another name: change the slug and every `harness_slug`, or `harness` in `cavelon.yaml`. |
| `package_file_invalid` | 3 | A package file is not valid YAML or JSON (the finding names the parser's line; for a quote that is never closed, the line where it opens), or it is a symlink to a file outside the solution folder or to no file. A link inside the solution folder is read as the file it leads to. What names the entries of a file that cannot be read is not checked until it can be. |
| `project_file_invalid`, `env_file_invalid` | 3 | `cavelon.yaml` or `env/<name>.yaml` is not valid YAML or has a wrong value. |
| `project_file_has_secret` | 3 | `cavelon.yaml` contains something that looks like a token. Remove it, revoke the token, and use `cavelon login` or `CAVELON_TOKEN`. |
| `no_solution` | 2 | The command needs a solution folder: run it in a folder with `cavelon.yaml`, or `cavelon init` first. |
| `persona_message_empty` | 0 (a warning) | The persona turns a greeting or fallback on (`greeting_enabled`, `fallback_message_enabled`; on by default) but its text is empty. Write `greeting_message` or `fallback_message` in `package/persona.yaml`, in the language the assistant answers in, or turn it off. |
| `test_assertion_unchecked` | 0 (a warning) | A test step has assertions (criteria with a `type`, such as `handoff_to`), and the instance's package schema does not describe a step's criteria, so `validate` cannot check them. An instance that knows the type checks it in code; one that does not grades it as a judge criterion. A newer instance publishes the criterion shapes, and `validate` then checks each assertion like any other field. Said once per suite file. |
| `solution_not_found` | 1 | The solution named by `--harness`, `cavelon.yaml` or an env file does not exist in this tenant, by name, slug or id. The error names the closest solutions (`details.candidates` with `--json`); `cavelon harness list` shows those that do, with name, slug and id. |

A finding with a code of the instance's rules (such as a graph rule) is
explained by `cavelon explain <code>`, as are `cavelon`'s own codes (the ones on
this page). For a code it does not know, `explain` names the closest known
ones: a typo away, or with the same start. Warnings fail `validate` only with
`--strict`; errors exit 3.

The first `pull` after you applied hand-written files keeps them where the
export only spells out what the file leaves out (an empty list or object,
`null`, a default): the values are the same. It rewrites a file whose value
changed on the instance, in the export's form (every field, in the schema's
order). `cavelon fmt` brings the files into that form before you apply, and
`cavelon fmt --check` exits 3 while one is not. A test suite goes back to the
file it came from, whatever its name.

Test cases or steps written without `sort_order` or `step_order` all import
with the default, and the instance orders them its own way (test cases by
name). `cavelon fmt` sets each one that is missing from its position in the
list, so they keep the written order. A file that `cavelon` 0.1.5's `fmt` gave
`sort_order: 0` on every case keeps that value: remove those lines and run
`cavelon fmt` again.

`pull` of a solution leaves the tenant-wide sections (`tenant_settings`,
`model_registry`, or the sections the instance marks `x-cavelon-scope: tenant`)
out of the solution's folder, and `apply` leaves them out of the solution's
import. `cavelon pull --include-tenant-wide` writes them (it says so when the
export carries none), and `cavelon apply --include-tenant-wide` imports them,
for every solution of the tenant. The preview says which it left out, or, with
the flag, which active solutions the change reaches (`tenant-wide:` in the
text, `tenant_wide` in `--json`, from the instance's own report where it sends
one). A file of one already in the folder is kept, listed under `kept`, with a
warning, and `validate` warns about it (`tenant_wide_section`); another finding
in such a file (a Model Registry row's `max_concurrent_requests`, say) says
that a solution's apply leaves the section out. To change one row's endpoint
limit, `cavelon models set-limit` needs no package at all. An instance that
does not publish `include_tenant_wide` imports such a file with every
solution's package, and `apply` says so: remove the file unless that is meant.
The flag was `--tenant-wide` in 0.1.7; that spelling is still taken, with a
warning.

On a development build of the instance, `validate` may report a field or
section the instance has just gained as unknown: the build keeps its version
while its schema changes, and `validate` reads the schema again only once its
cached copy is a minute old (`CAVELON_CONTRACT_TTL_SECONDS`), or when the
instance's ETag says it changed. `cavelon validate --verbose` names the copy it
used: cached or read now, when, and its hash.

On Windows, concurrent calls can briefly hold a cached contract file open while
another call replaces it. The kit retries these sharing-lock errors up to six
times, with at most 310 ms of retry delays. It keeps the old complete file if
replacement still fails and reports the error; it does not delete the cache to
force a write. Other filesystem errors are reported without retrying.

## Preview and apply

| Code | Exit | Cause and fix |
|---|---|---|
| (blocked preview) | 3 | The preview has blockers and no preview id. Each blocker names its code, the package file and path, and a hint where the instance sends them; `cavelon explain <code>` says more. Fix them and run `cavelon apply` again. |
| `import_preview_stale` | 4 | The solution changed on the instance after the preview. Nothing was imported. Run `cavelon apply` again and confirm the new preview. |
| `package_requirements_changed` | 4 | The import's own check found something the preview did not; each blocker is listed. Nothing was imported. Fix the blockers and preview again. |
| `solution_not_found` | 1 | The solution the env file, `cavelon.yaml` or `--harness` names is not in this tenant: "not found", so exit 1, also when it is only not created yet. `apply` previews into an existing solution and never creates one: create the draft with the `cavelon harness new <slug>` the hint names (with `--name` when the package's `harnesses.yaml` has an entry with that slug, and `--tenant` when you gave one), then preview again. `cavelon harness list` shows the tenant's solutions. |
| (nothing to import) | 0 | The preview changes nothing: the instance already holds what the package files say. `apply` says "Nothing to import", stores no preview and prints no confirm command (`nothing_to_import` with `--json`). |
| `preview_unknown` | 2 | No preview with that id was made in this folder (or it was removed long ago). `cavelon status` lists the open ones. |
| `preview_superseded` | 4 | Another preview was imported after this one, so what it showed is no longer what an import would do (`details.superseded_by` names that preview). Nothing was imported. Run `cavelon apply` again and confirm the new preview. |
| `preview_applied` | 4 | The preview was imported already; nothing was imported again. `cavelon apply` previews the files as they are now. |
| `preview_discarded` | 4 | The preview was forgotten with `apply --discard`. Nothing was imported. Preview again. |
| `preview_files_changed` | 4 | The package files changed in what they hold since the preview; the error names them. Nothing was imported. Run `cavelon apply` again and confirm the new preview, or add `--allow-stale` to the confirm to import what the old preview showed. |
| `preview_expired` | 4 | The preview is more than a day old (or a newer preview removed it as expired). Nothing was imported, and the stored preview is removed. Run `cavelon apply` again and confirm the new preview. |
| `preview_other_tenant`, `preview_other_instance` | 4 | The preview was made for another tenant or instance than the one this command uses. Preview again here. |
| `uncommitted_changes` | 4 | `pull` would overwrite package files with uncommitted changes. Outside a git repository: it would overwrite or remove a package file that changed since the last pull, such as your edit or a test suite you have not applied. A file as the last pull or confirmed apply left it is never listed. The files are listed. Commit them, apply them, or use `--force` to discard them. |
| `package_file_outside` | 4 | `pull` or `init --from` would write a package file that is a symlink to a file outside the solution folder. Nothing was written. Move the file into the solution folder, or replace the link with the file. |
| `package_files_differ` | 4 | `init --from` would change or remove package files that hold something else. The files are listed; `--force` replaces them. |

**A database query blocks the apply.** `database_query_needs_superadmin` means
the credential lacks permission to create or change the query's SQL,
parameters, limits, kind, confirmation setting or tool name/description.
The current manage gate permits the tenant Owner's personal access token
after the person's approval; follow the instance's hint because older builds
can still require a superadmin in the Admin. One such blocker stops the
whole import. Restore that tool as the last pull wrote it or remove its
`database_query` block to apply the rest. A missing or untested connection
needs the tenant Owner's setup and `cavelon db test <connection>`.

**The database cap refuses a new entry.** `database_connection_limit_reached`
or `database_query_limit_reached` names the tenant's cap and current count;
the query code can block an import preview. Read `cavelon db instance` or
`cavelon limits`, delete entries no longer needed, or ask the platform operator
to raise the tenant's override. Existing entries above a lowered cap keep
working. See [Database limits](limits.md#database-connections-and-queries).

For writes, `writes_not_allowed` includes dry-run tests: a person enables
writes on the connection in the Admin. Omitted `allows_writes` is unknown.
`too_many_rows_affected` means the transaction rolled back.
`write_outcome_unknown` means the commit outcome is unknown: never retry;
check the database before any repetition. `write_statement_refused` and
`write_procedure_definition_refused` are save-time checks; use `cavelon
explain <code>` for the instance's rules. A confirmation-required direct
query node answers `confirmation_unavailable`. Its per-run budget refusal
is `tool_call_limit_reached`, counted across direct nodes, Agent stages,
iterations, concurrent branches and resume. Agent per-turn limits apply
as well. Read queries have no run cap; ordinary chat per-turn limits are
unchanged. See [write queries](connect-a-database.md#write-queries).

**A query tool answers `identity_required` in a test.** The query reads a
signed-in visitor's identity (`end_user.*`), or does not allow anonymous
callers, and a test run has no signed-in visitor. Check the query for one
customer with `cavelon db test-run <query> --value email=<address>`; see the
testing skill.

**Activation still needs a person when nothing reaches it.** The kit reads
`channel_count` from the matching solution-list row when the single read
leaves it null. If the list is unreadable, omits the row or its count, reach
stays unknown. Readiness must also explicitly publish
`takes_default_route: false`; a missing flag stays unknown even with a false
schema default.
A true flag needs your yes, including assigning an unassigned default
route. The preview reserves no state; successful activation reports what
actually happened in `took_default_route` and its from/name fields.

**My active solution does not answer in the chat or widget.** The tenant's
chat and widget answer only with its default route. `cavelon harness list`
shows which solution that is (DEFAULT). Try yours by name with
`cavelon chat "<message>" --harness <solution>`; to make it answer there,
`cavelon harness default <solution>` previews the change, and a person
confirms it with `--confirm`. To take a solution out of live traffic,
`cavelon deactivate --harness <solution>` previews, and `--confirm`
deactivates (its status becomes `inactive`); the default route is refused
until another solution is the default.

**`init` refuses the name of my new solution.** A name close to an existing
solution's (`qa-v2` beside `qa`) may be a typo, so `init --harness <name>`
refuses it with `solution_not_found` and names the closest ones. For a new
solution of that name, add `--new`.

**A copied command acted in another tenant.** Every command `cavelon` prints
(in a hint, a `next` or `resume` field, or a preview's confirm line) carries
the `--tenant`, `--env` and `--instance` you gave on the command line, the
confirm lines of `deactivate`, `activate --make-default`, `harness default` and
`apply` included. Outside a solution folder, pass `--tenant` to every command
until `cavelon.yaml` names the tenant: without it a command acts in the tenant
`cavelon use` chose.

**A coding agent's `--confirm` exits 5.** Run by a coding agent, a confirming
command takes the token its preview printed (`--confirm <token>`); the bare
flag only shows the preview. Run the confirm command the preview printed.
Where the preview says `needs_person: "terminal"` (a change only a person may
confirm), it prints no token: the person runs the command it names in their
own terminal, and a token gets `confirm_needs_person`.

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

## After upgrading to 0.2, an agent still runs 0.1

The session warns that the plugin or a solution's skills are behind, or
`cavelon setup --check` shows an agent's tools starting
`npx -y @cavelon/cli@0.1 mcp`. Something that starts the server still names
the 0.1 release line:

- **The plugin**: update it with the client's own commands, then start a new
  session ([Refresh your coding agents](upgrading-to-0.2.md#2-refresh-your-coding-agents)).
- **An entry `setup` wrote**: run `cavelon setup` again with the same
  environment you set it up with, then `cavelon setup --check`.
- **A solution's committed files**: run `cavelon init --update` in that
  solution's folder and commit the result.
- **An entry neither recognizes**: `setup` and `init --update` move only an
  entry that is exactly a form the kit writes, in a file they manage. One
  with other options, another command or a `uvx` range, or one in a file they
  do not manage, stays as it is. Change it to `cavelon mcp` or
  `@cavelon/cli@0.2` by hand.

A `cavelon` installed in more than one way can also hide the new one: the
plugin starts the first `cavelon` on the `PATH`, and `cavelon --version` names
which one that is. [Upgrading from 0.1 to 0.2](upgrading-to-0.2.md) has the
whole sequence.

## Still stuck

- Run the command with `--json` and read the whole error, including `details`.
- `cavelon docs search <words>` searches your instance's documentation. The
  docs are in English: German words for the core concepts (Wissensbasis,
  testen, Standard) are looked up in English, and other questions do best in
  English words. When nothing matches, it says so (and suggests English words
  only for a German question); `cavelon docs get index` lists every page.
- Report a problem with the kit on
  [GitHub issues](https://github.com/goodguys-gmbh/cavelon-dev-kit/issues),
  with the command, its output and `cavelon --version`. Leave out tokens,
  secrets and customer data. A security problem goes through
  [SECURITY.md](../SECURITY.md) instead.

## Cline finds no project MCP file or custom editor skills

Cline reads shared user MCP settings; init copies native project skills only.
Run `cavelon setup --agents cline` with the same configuration environment as
the CLI. The released editor’s compatibility UI still uses legacy path rules;
use default shared paths and check its settings/skill menu separately. Restart
the client after changes. An older profile is not silently migrated by setup.
See [Cline](install/cline.md#check) and its
[guarded launch](install/cline.md#guarded-shell).

## Kilo reports a conflicting or different effective binding

Kilo can merge global, inherited project, environment, compatible OpenCode and
managed settings. Setup preserves compatible files and refuses ambiguous
Cavelon ownership. The native tools also refuse if the effective merged entry
differs from their recorded binding. Review Kilo’s resolved configuration and
organization policy, retain personal servers, then repeat setup only after
resolving the conflict. Keep the built-in duplicate disabled. Restart the
client and verify the native tools and four skills; file checks cannot certify
UI loading. The editor/headless approval route is the person’s own terminal.
See [Kilo](install/kilo.md#check).

## Goose cancels a confirmation or finds a competing configuration

Plain `goose run` is headless. An elicitation error in that mode sends no
Cavelon confirmation or guarded mutation; use an interactive session or make
a fresh preview and confirm it yourself in your separate terminal. Do not pipe
answers. Goose 1.53.0 expires its form after five minutes; a later answer can
report `Request not found`. It does not approve the change. Start a new preview
and fresh form. CLI forms and Desktop/ACP host UI checks are separate.

Compare `goose info` with setup's configuration path. Keep path-root/XDG and
additional configuration overrides the same. Setup refuses a Cavelon entry in
system/additional layers, a competing extension name, an active allowlist or
ambiguous YAML. Review that binding with the operator rather than adding a
shadow entry. See [Goose](install/goose.md#check).

### OMP loads no Cavelon tools or a different profile

Use the same `OMP_PROFILE`/`PI_PROFILE`, `PI_CONFIG_DIR` and default
`PI_CODING_AGENT_DIR` selection for setup and launch. Named OMP profiles ignore
the default agent-directory override. Inspect native autoload and custom
plugin/discovery settings in OMP; file checks alone do not prove loading. Setup
preserves a personal autoload entry and compatible Cavelon bindings, and refuses
Cavelon in deny/force-enable lists. Review those settings before repeating setup.
See [OMP](install/omp.md).
