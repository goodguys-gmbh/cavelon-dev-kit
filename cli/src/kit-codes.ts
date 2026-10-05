import type { CatalogEntry } from "./contracts.js";

/**
 * The codes `cavelon` itself answers with, beside the instance's catalog: an
 * error the kit raises before or instead of a request (`operation_not_found`
 * from `cavelon api`, `uncommitted_changes` from `pull`). `cavelon explain`
 * looks them up after the instance's catalog, which wins where it lists the
 * same code. A test keeps this list in step with the codes in the source.
 */
export const KIT_ERROR_CODES: CatalogEntry[] = [
  // Login, instance and tenant.
  { code: "not_logged_in", area: "cli", message: "There is no token for the instance.", hint: "A person runs `cavelon login` (or sets CAVELON_URL and CAVELON_TOKEN); an agent never handles the token." },
  { code: "no_instance", area: "cli", message: "No Cavelon instance is selected.", hint: "Run `cavelon login --instance <url>`, set CAVELON_URL, or work inside a folder with cavelon.yaml." },
  { code: "unauthorized", area: "cli", message: "The instance refused the token: expired, revoked, or for another instance.", hint: "A person creates a new token on /account/access-tokens and runs `cavelon login`." },
  { code: "tenant_required", area: "cli", message: "The command acts in a tenant, and none is chosen.", hint: "Choose one with `cavelon use` (it lists your tenants), or pass --tenant <name or slug>." },
  { code: "tenant_not_found", area: "cli", message: "No tenant by that name, slug or id that this token reaches.", hint: "`cavelon tenant list` shows the tenants; `cavelon whoami` which ones the token reaches." },
  { code: "no_tenant_reached", area: "cli", message: "The token reaches no tenant on this instance.", hint: "A person adds the token's owner to a tenant, or creates a token for one; `cavelon whoami` shows what it reaches." },
  { code: "api_key_inactive", area: "cli", message: "The tenant API key is revoked or inactive.", hint: "A person creates a new key in the Admin." },
  { code: "api_key_cannot_create_tenants", area: "cli", message: "A tenant API key can never create a tenant.", hint: "Use a personal access token that allows Platform mode, owned by someone with tenants.manage." },
  { code: "platform_mode_not_allowed", area: "cli", message: "The token may not enter Platform mode, which the change needs; nothing was sent.", hint: "A person creates a token with Allow Platform mode and a platform ceiling, or makes the change in the Admin." },
  { code: "permission_missing", area: "cli", message: "The token lacks a permission the change needs; nothing was sent.", hint: "`cavelon whoami` shows the token's ceiling; a person makes the change, or creates a token whose role grants it." },
  { code: "platform_role_required", area: "cli", message: "The change is an operator's: it needs a personal access token in Platform mode of a platform role; nothing was sent.", hint: "Ask the instance's operator, or run it with an operator's token." },
  { code: "forbidden", area: "cli", message: "The credential may not make this change; nothing was sent.", hint: "The message names the permission; a person with it makes the change, or in the Admin." },
  { code: "token_activation_refused", area: "cli", message: "The personal access token was not created with \"may activate\", so it cannot activate solutions.", hint: "A person activates the solution in the Admin, or creates a token with \"may activate\"." },
  { code: "secret_needs_a_person", area: "cli", message: "A tenant API key cannot set or delete a secret; nothing was sent.", hint: "A person logs in with a personal access token and runs `cavelon secrets set <name>`, or uses the Admin." },
  { code: "foreign_url", area: "cli", message: "cavelon refused to send the token to a URL outside the instance.", hint: "Check the instance URL; the token goes only to the instance it was stored for." },
  // Network and the instance's answers.
  { code: "network_error", area: "cli", message: "The instance could not be reached.", hint: "Check the instance URL and the network (VPN, proxy, allowlist)." },
  { code: "request_timeout", area: "cli", message: "The instance did not answer in time.", hint: "Retry; CAVELON_HTTP_TIMEOUT_MS raises the limit per request." },
  { code: "unexpected_redirect", area: "cli", message: "The instance redirected a request elsewhere.", hint: "Check the instance URL (https, host, path)." },
  { code: "internal_error", area: "cli", message: "cavelon failed in an unexpected way.", hint: "Run the command again; if it repeats, report it with the command and its output." },
  { code: "operation_unavailable", area: "cli", message: "This instance does not offer what the command needs (the route or a field is not in its OpenAPI).", hint: "The instance may be older than the feature; `cavelon status` shows its version." },
  { code: "openapi_unavailable", area: "cli", message: "The instance does not serve its OpenAPI.", hint: "`cavelon api` needs it; ask the instance's operator to route it." },
  { code: "error_catalog_unavailable", area: "cli", message: "The instance does not publish its error catalog.", hint: "Try `cavelon docs search <code>`." },
  { code: "docs_unavailable", area: "cli", message: "The instance does not serve its docs to agents (no /llms.txt).", hint: "Read the docs in the Admin until the instance is updated." },
  { code: "doc_not_found", area: "cli", message: "No docs page by that name on this instance.", hint: "Find it with `cavelon docs search <words>`." },
  { code: "code_unknown", area: "cli", message: "The code is neither in the instance's error catalog nor one of cavelon's own.", hint: "Check the spelling against the similar codes `cavelon explain` names, or try `cavelon docs search <code>`." },
  // cavelon api.
  { code: "operation_not_found", area: "cli", message: "No such operation: `cavelon api` found no operation by that name in the instance's OpenAPI, or `cavelon wait` no operation (op_…) by that id in this tenant.", hint: "`cavelon api list --search <text>` finds an operation; operation ids are per tenant (`cavelon whoami`, `cavelon status`)." },
  { code: "operation_ambiguous", area: "cli", message: "The short name matches several operations.", hint: "Use the full operationId the message lists." },
  { code: "operation_for_a_person", area: "cli", message: "The operation stays with a person (the instance marks it, or it changes a secret, a credential or an approval), so an agent does not send it.", hint: "A person runs it in their own terminal, or in the Admin." },
  { code: "secret_field_for_a_person", area: "cli", message: "The request sets a field the instance marks as a secret value, so an agent does not send it.", hint: "Leave the field out; a person enters the value with `cavelon secrets set <name>` or in the Admin." },
  { code: "confirmation_required", area: "cli", message: "The command changes something and there is no terminal to ask.", hint: "Read the plan it printed, then run it again with --yes (or --confirm, where it takes that)." },
  // Operations (op_…).
  { code: "operations_unavailable", area: "cli", message: "The instance does not offer the operations API.", hint: "Its operator turns it on with OPERATIONS_API_ENABLED." },
  { code: "not_an_operation_id", area: "cli", message: "That is not an operation id; they start with op_.", hint: "Commands that start work print the operation id; `cavelon status` lists running ones." },
  { code: "operation_gone", area: "cli", message: "The operation no longer exists on the instance.", hint: "Start the work again; `cavelon status` lists the running operations." },
  { code: "stream_error", area: "cli", message: "The event stream of an operation broke off.", hint: "`cavelon wait <op_id>` polls instead." },
  // Solution folder and package files.
  { code: "no_solution", area: "cli", message: "This folder is not a Cavelon solution (no cavelon.yaml here or above).", hint: "Run `cavelon init`; `cavelon harness list` shows the tenant's solutions." },
  { code: "solution_not_found", area: "cli", message: "No solution by that name, slug or id in this tenant.", hint: "`cavelon harness list` shows them; `cavelon harness new <slug> --name <name>` creates one as a draft, which apply never does." },
  { code: "project_file_invalid", area: "cli", message: "cavelon.yaml is not a valid YAML mapping.", hint: "Fix the file at the place the message names." },
  { code: "project_file_has_secret", area: "cli", message: "cavelon.yaml holds a credential; solution files never do.", hint: "Remove it, revoke the token, and use `cavelon login` or CAVELON_TOKEN instead." },
  { code: "env_file_invalid", area: "cli", message: "An env/<name>.yaml file is invalid (not a mapping, a runtime binding that is not a resource id, or an unknown mode).", hint: "Fix the field the message names." },
  { code: "uncommitted_changes", area: "cli", message: "pull would overwrite or remove package files with changes that are not committed and not what the last pull or apply left.", hint: "Commit them first, apply them with `cavelon apply`, or pass --force to discard them." },
  { code: "package_files_differ", area: "cli", message: "init --from would change or remove package files that hold something else; nothing was written.", hint: "Commit or compare them first, then pass --force to replace them." },
  { code: "package_file_outside", area: "cli", message: "A package file is a link to a file outside the solution folder; nothing was written.", hint: "Move the file into the solution folder and link to it there, or replace the link with the file." },
  { code: "package_import_invalid", area: "cli", message: "The file given to init --from is not a package export.", hint: "Pass a JSON or YAML file with one key per section (manifest, harnesses, agents, …)." },
  { code: "package_schema_unavailable", area: "cli", message: "No package schema is cached for the instance, and it was not read.", hint: "Run `cavelon validate` once without --offline (or `cavelon pull`) while the instance is reachable." },
  { code: "package_version_unsupported", area: "cli", message: "The package is written in a format the instance does not accept.", hint: "`cavelon status --json` lists the accepted versions; pull the package again to get the current one." },
  { code: "export_invalid", area: "cli", message: "The instance's export was not a package.", hint: "Retry; if it repeats, the instance's export is broken (`cavelon status` shows its version)." },
  { code: "file_exists", area: "cli", message: "The output file exists; cavelon does not overwrite it.", hint: "Choose another file with --out." },
  { code: "path_outside_solution", area: "cli", message: "A tool reads and writes files only inside the solution folder.", hint: "Name a file inside the solution folder, or ask the person to run the command in their terminal." },
  { code: "path_in_kit_directory", area: "cli", message: "The file is in cavelon's own directory (login and cache); no tool reads or writes there.", hint: "Name a file in the solution folder." },
  { code: "skills_missing", area: "cli", message: "This cavelon has no skills to install; its package is incomplete.", hint: "Reinstall @cavelon/cli." },
  // apply, activate and the default route.
  { code: "preview_unknown", area: "cli", message: "No open preview with that id in this solution.", hint: "Run `cavelon apply` for a new preview and confirm its id; `cavelon status` lists the open ones." },
  { code: "preview_other_instance", area: "cli", message: "The preview was made on another instance.", hint: "Confirm it with the instance it was made on, or preview again here." },
  { code: "preview_other_tenant", area: "cli", message: "The preview was made for another tenant than this command acts in.", hint: "Run the confirm command the preview printed (it names --env and --tenant), or preview again here." },
  { code: "preview_files_changed", area: "cli", message: "The package files changed since the preview; nothing was imported.", hint: "Run `cavelon apply` for a preview of the files as they are now, show it, and confirm its id; --allow-stale with --confirm imports what the old preview showed." },
  { code: "preview_expired", area: "cli", message: "The preview is older than the kit keeps previews; nothing was imported.", hint: "Run `cavelon apply` for a new preview, show it, and confirm its id." },
  { code: "confirm_token_required", area: "cli", message: "Over MCP, or run by a coding agent in its shell, a changing command confirms only with the token its preview returned, never with true or a bare --confirm.", hint: "Call the tool (or run the command) without confirm, show the person the preview, then call it again with the same arguments and confirm set to its confirm_token (--confirm <token> in a shell)." },
  { code: "unknown_argument", area: "cli", message: "An MCP tool was called with an argument its schema does not list; nothing was done.", hint: "Call it again with the argument the error names (the tool's schema lists them all), spelled in snake_case." },
  { code: "solution_not_active", area: "cli", message: "Only an active solution can be the tenant's default route; this one is a draft (or archived), so nothing was changed.", hint: "Activate it through the readiness gate and preview the default route in one step: `cavelon activate --harness <slug> --make-default`." },
  { code: "default_route_deactivate", area: "cli", message: "The solution is the tenant's default route, so deactivate refused it; nothing was changed.", hint: "Ask the person which solution should answer in the tenant's chat and widget instead, make it the default (`cavelon harness default <solution>`), then deactivate." },
  { code: "default_route_unknown", area: "cli", message: "The instance does not say which solution is the tenant's default route (no is_default in its solution list).", hint: "The instance may be older than default routes; check the default in the Admin." },
  // Limits, quotas and models.
  { code: "limit_not_found", area: "cli", message: "The instance lists no limit by that key.", hint: "`cavelon limits` lists the keys." },
  { code: "limit_changed_by_operator", area: "cli", message: "The limit is not the tenant's to change: the operator sets it; nothing was sent.", hint: "Ask the instance's operator; `cavelon limits --key <key>` says who changes it and how." },
  { code: "tenant_quota_reached", area: "cli", message: "The tenant's solution quota is used up; nothing was sent.", hint: "A platform administrator raises the quota (`cavelon limits` shows it); archiving an unused solution frees one." },
  { code: "license_limit_reached", area: "cli", message: "The licence's cap on solutions is reached; nothing was sent.", hint: "Archive an unused solution, or ask the operator for a renewed licence." },
  { code: "model_not_found", area: "cli", message: "The tenant's Model Registry has no row by that name or id.", hint: "`cavelon models list` shows its rows by model_id and id." },
  { code: "variable_not_set", area: "cli", message: "The tenant has no variable by that name.", hint: "`cavelon variables list` shows them; `cavelon variables set <name> <value>` sets one." },
  // Tests, traces, loops and Sandboxes.
  { code: "no_suites", area: "cli", message: "The solution (or tenant) has no test suites.", hint: "Write one in tests/ and apply it; the cavelon-testing skill shows how." },
  { code: "no_result", area: "cli", message: "The operation has no result yet.", hint: "`cavelon wait <op_id>` waits for it." },
  { code: "no_trace", area: "cli", message: "The operation's result has no trace.", hint: "Trace a run, test run or conversation id instead." },
  { code: "run_not_found", area: "cli", message: "No run, test run or conversation with that id in this tenant.", hint: "Check the id and the tenant (`cavelon whoami`); --kind names what the id is." },
  { code: "trace_not_found", area: "cli", message: "No trace with that id under the run.", hint: "`cavelon trace <run>` lists the run's traces." },
  { code: "span_not_found", area: "cli", message: "No span with that id in the trace.", hint: "`cavelon trace <run> --trace <id>` lists its spans." },
  { code: "loop_not_found", area: "cli", message: "The run has no loop (yet).", hint: "A loop starts when the run reaches its Masterloop node; `cavelon loop watch <run>` waits for it." },
  { code: "loop_state_conflict", area: "cli", message: "No loop of the run is in a state that allows this.", hint: "`cavelon loop iterations <run>` shows each loop's state." },
  { code: "loop_resume_review_required", area: "cli", message: "The loop paused for a cause a person checks before it resumes.", hint: "A person checks the cause the message names and fixes it, then resumes with the reason." },
  { code: "loop_not_resumable", area: "cli", message: "The loop cannot be resumed.", hint: "Stop the run, fix the cause and start a new run." },
  { code: "sandbox_harness_not_allowed", area: "cli", message: "The solution may not use the Sandbox.", hint: "A person grants Sandbox Access (the allowed solutions) in the Admin." },
  { code: "sandbox_capability_unavailable", area: "cli", message: "The instance does not offer this Sandbox capability.", hint: "The instance may be older than the feature; `cavelon status` shows its version." },
  { code: "sandbox_validation_receipt_unavailable", area: "cli", message: "The instance does not offer a Sandbox validation receipt.", hint: "The instance may be older than the feature; `cavelon status` shows its version." },
  { code: "sandbox_workspace_refresh_unavailable", area: "cli", message: "The instance does not offer refreshing a Sandbox workspace.", hint: "The instance may be older than the feature; `cavelon status` shows its version." },
  { code: "sandbox_transfer_size_limit", area: "cli", message: "The archive is larger than a Sandbox imports at once.", hint: "Seed fewer or smaller files; a seed replaces the whole workspace." },
  { code: "sandbox_artifact_digest_mismatch", area: "cli", message: "The export arrived with another digest than the instance declared; nothing was written.", hint: "Download it again." },
  { code: "invalid_job_id", area: "cli", message: "The instance returned an unexpected job id.", hint: "Retry; if it repeats, report it with the command." },
  // Generic answers.
  { code: "usage", area: "cli", message: "The command was called the wrong way (a missing or invalid argument or option).", hint: "`cavelon <command> --help` shows its arguments." },
  { code: "validation_failed", area: "cli", message: "A value did not pass the check before it was sent, or the instance refused it as invalid.", hint: "The message names the field; `cavelon api describe <operation>` shows the shape." },
  { code: "cancelled", area: "cli", message: "Nothing was chosen or confirmed, so nothing changed.", hint: "Run the command again, or name the choice with an option." },
];

/** The kit's own codes that `cavelon explain` knows, by code. */
export function kitErrorEntry(code: string): CatalogEntry | undefined {
  return KIT_ERROR_CODES.find((e) => e.code === code);
}
