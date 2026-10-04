# Changelog

All notable changes to the Cavelon dev-kit are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project uses [semantic versioning](https://semver.org/): one version for the
CLI, the skills and the plugin.

## [Unreleased]

## [0.1.5] - 2026-10-04

Agents get further on their own: validate catches broken references, unknown
fields and models before an import, the preview says what will change and
what blocks it, re-uploading a file replaces it, the persona and the default
route are part of authoring, test steps can check routing, and `brew install`
works on macOS and Linux.

### Added

- Homebrew: `brew install goodguys-gmbh/cavelon/cavelon` on macOS and Linux;
  the release workflow updates the formula in goodguys-gmbh/homebrew-cavelon
  on every release, and `brew upgrade cavelon` updates.

- `cavelon harness default [solution]` (MCP tool `harness_default`) makes a
  solution the tenant's default route, the one its chat and widget answer with
  where no solution is named. Without `--confirm` it changes nothing and names
  the current default and the one that would replace it
  (`default → Default (default) now; would become Support (support)`).
- `cavelon activate` says when the solution is not the tenant's default route,
  and `--make-default` previews making it the default; with `--confirm` as
  well, it changes it (`default_route` in `--json`). An instance that does not
  mark the default says nothing of it.
- `cavelon harness list` marks the default route in a DEFAULT column; an
  instance that does not mark it leaves the column out (`is_default: null`).
- `cavelon fmt` (MCP tool `fmt`) brings hand-written package files into the
  form the instance's export gives them, from the package schema, offline:
  the defaults it fills in, its field order, block lists. The first `pull`
  after an apply then rewrites only what changed on the instance.
  `--check` writes nothing and exits 3 when a file would change.
- `pull` and `init` write `package/persona.yaml` with every field the
  instance's schema lists; a field that is not set is a comment with its
  default, so the persona's shape is visible. A file of placeholders only sets
  nothing and sends nothing.
- `cavelon validate` warns when the persona turns a greeting or fallback on
  (or leaves it on by default) with an empty text (`persona_message_empty`).
- `cavelon explain` knows `cavelon`'s own error codes (`operation_not_found`,
  `uncommitted_changes`, …), and adds the command that does what the instance's
  fix asks of an API route (for `package_schema_invalid`: `cavelon validate`
  and `cavelon schema`).
- `cavelon apply` shows the structured preview of recent instances: each
  blocker with its code, package file, line and path, hint and the `cavelon
  explain` command (`blocker_details`); each field it changes as
  `object.field: old → new` (`field_changes` in `--json` and the MCP result);
  and the fields it does not apply, with the command that sets each
  (`not applied: harnesses[0].is_default (set with cavelon harness default
  support)`; `not_applied`). An instance without them keeps today's output.
- The authoring skill has a Persona section (who the assistant is, as opposed
  to an agent's `system_prompt`; greeting and fallback in the content
  language), and the loop skill tells the agent to ask the person before
  making a solution the default route.
- `cavelon schema [section]` (MCP tool `package_schema`) shows the package
  schema the instance publishes: without a section, every section with the file
  it is kept in; with one, its fields (type, required, allowed values, default)
  and the smallest entry that has every required field, as YAML to copy into
  the file. It reads the schema as `validate` does, the cached copy first, and
  works with `--offline`.
- `cavelon whoami` says whether the token may enter Platform mode, with its
  ceiling (`platform mode: not allowed (ceiling tenant_builder)`), and which
  tenants it reaches (`reaches: every tenant (as operator; …)`);
  `credential.platform_mode_allowed` in `--json`.
- `cavelon status` shows the solution's state: draft or active, whether it is
  ready to activate (or the blockers), and its latest test run, from the
  readiness the instance publishes (`solution.state` in `--json`). An instance
  whose readiness does not name the latest run says so.
- `cavelon kb upload` names each file whose name matches an active document of
  the knowledge base, in `--dry-run` and after the upload:
  "bergbahn-faq.md exists (094e95e9…) and stays active". `--replace` replaces
  that document: through the instance's own replacement (`replace_doc_ids`),
  reading what was replaced from `replaced_document_ids` where the instance
  reports it; on an instance whose upload cannot replace, it uploads and then
  deactivates the old document, and only with `--confirm`. On an instance that
  replaces same-named documents by default, `--keep-both` keeps both.
  `--dry-run` now looks the knowledge base up, so it fails for one that does
  not exist. The cavelon-loop skill says how to update a document. `pull` writes
  `.cavelon/inventory.json` next to `inventory.md`, which now lists skills and
  models too.
- `cavelon validate` checks what the schema cannot, each with file and line:
  two entries with one slug (`package_duplicate_key`) and a handoff to an agent
  the package lacks (`package_reference_missing`) are errors; a skill, tool,
  knowledge base or solution that is neither in the package nor among what the
  tenant held at the last pull (`package_reference_unknown`), a field the
  package schema does not have (`package_field_unknown`, "did you mean
  temperature?"), and an agent's `llm_model` outside the tenant's model list as
  `pull` or `models list` last read it (`package_model_unknown`) are warnings.
  A finding carries the closest name as `suggestion`; a required field under
  another name is reported once, as the missing field, with the suggestion.
- `cavelon docs get index` prints the instance's whole docs index.
- `cavelon trace` shows what the agent recorded a knowledge search found:
  `knowledge_outcome` (`usable_evidence`, `content_gap`, `unusable_hits`,
  `retrieval_fault`, `deliberately_unanswerable`) on the search's tool span
  and its retrieval span, in a KNOWLEDGE_OUTCOME column and in `--json`. For a
  test run it names the agent that answered each step (AGENT, `agent` in
  `--json`), and a case that did not pass says `Answered by: <agent>`. An
  instance that records neither shows neither.
- The cavelon-testing skill teaches the step assertions `tool_called`,
  `tool_not_called`, `answered_by` and `handoff_to`, with an example for a
  solution with a handoff, so routing becomes part of the regression.
- `cavelon validate` warns `test_assertion_unchecked`, once per suite file,
  when a test step has assertions (criteria with a `type`) and the instance's
  package schema does not describe a step's criteria: it cannot check them,
  and an instance that does not know a type grades it as a judge criterion.
  Where the schema describes them, each assertion is checked like any other
  field.
- `cavelon apply --confirm` shows the structured blockers of an import its own
  check refuses, as a preview does: code, package file and line, path, hint
  and the `cavelon explain` command (`blocker_details` in `--json` and the MCP
  result), for a `409 package_requirements_changed` and for a 422 of an import
  blocked when it applies. An instance that sends only the `blockers`
  sentences keeps today's output.

### Changed

- `cavelon apply` looks at `ready` before the preview id: a blocked preview
  (which has no id on a recent instance) prints its blockers and no longer
  warns to update the instance.
- `cavelon explain` suggests, for a code it does not know, the codes a typo
  away or with the same start, never one that shares only a common word in the
  middle; `details.similar` in `--json`.
- `cavelon api describe` shows the item fields of a body field that is a list
  of objects, under `<field>[]` (`array of <Item>`).
- `cavelon api` sends the folder's solution as `harness_id` to the persona
  operations (`get_bot_persona`, `upsert_bot_persona`, …) when none is passed,
  and says so: without it they reach the tenant's default route.
- `pull` counts a field spelled `null` and one left out as the same, so a file
  keeps its bytes when only that differs.
- `cavelon tenant create` asks the instance first whether the token may enter
  Platform mode and, there, holds `tenants.manage`. When it does not, it stops
  with exit 7 before sending anything (`platform_mode_not_allowed`,
  `permission_missing`) and names the remedy: a token with **Allow Platform
  mode** and a platform ceiling, or the Admin. `--use` switches to the new
  tenant only once the instance confirms the token acts in it, and says so
  otherwise.
- A 403 from a platform route (the tenants, the platform's settings, the
  administration routes) no longer tells you to check the tenant: its hint says
  the route needs a token that allows Platform mode and points to
  `cavelon whoami`.
- `cavelon tenant list` with an operator's token that reaches every tenant
  says "No memberships of your own; …" with the `--search` to find any tenant,
  and its `--json` marks the list as the person's own memberships
  (`listed: "own_memberships"`, with a `note` on what `total` counts).
- `cavelon api` and `cavelon api describe` find an operation by a looser
  spelling (`createTenant` or `create-tenant` for `create_tenant`) and say
  which one they took; a near miss names the closest operations. A parameter
  passed as an option (`--harness_id x`) gets the hint to pass `harness_id=x`.
- `cavelon api` takes the request body with `--body`. `--json <body>` still
  sends it, with a warning, and will be removed in a later release; `--json`
  alone prints JSON as on every command.
- `pull` no longer refuses files as the last pull wrote them or the last
  confirmed `apply` imported them, in a git repository without a commit as
  outside git: `.cavelon/pulled-files.json` now holds the digests of both.
  Files git lists are matched in a solution that sits in a subfolder of the
  repository too.
- The MCP tool `operation_status` waits when given a `timeout`, until the
  operations settle or the time passes, at most 50 seconds (a longer timeout is
  cut there, with a warning); without one it returns the state at once.
  `wait` and `operation_status` report `timeout_ms` and `waited_ms`, and
  `timed_out` is true only when the whole timeout was waited, never for a
  state read once. The tool's description and the server's instructions say
  the same.
- The MCP descriptions of `init` and `pull` say that they change nothing on
  the instance (`pull` only reads it) and write files in the solution folder,
  instead of "Changes the instance; may delete or overwrite."
- `cavelon status` reads the instance's version now instead of from the
  cache, and offline marks the cached one with when it was read; `whoami`
  marks a cached version too. Its text shows the quotas it cannot read, and a
  403 on the quota usage says that the token's ceiling (named) does not read
  them and who does, instead of the raw refusal; `limits` says the same.
- `cavelon docs search` drops English and German stop words, matches whole
  words (in a simple base form, so "testing" finds "test" but "latest" does
  not), weighs rare words above common ones, looks German words for the core
  concepts up in English (Wissensbasis, testen, Standard, Bot), and lists only
  pages that match well, instead of every page that shares a letter sequence.
  When nothing matches, it says so, with the words it looked for, English
  words to try and `cavelon docs get index`. "Wie lade ich Dokumente in eine
  Wissensbasis hoch?", "Wie teste ich meinen Agenten?" and "Wie mache ich
  meinen Bot zur Standardantwort für alle Nutzer?" now find the concept page
  first.

- `cavelon login` and `cavelon setup` let an operator whose token reaches
  every tenant choose the tenant later: Enter at the question stores the token
  without a tenant, as `--token-stdin` does, and says how to choose one with
  `cavelon use`. The question now reads "Which tenant to start in? (type part
  of its name, or press Enter to choose later)", and the line above it says
  that the token works in every tenant, one at a time, switched with
  `cavelon use`, or chosen per command with `--tenant` and per solution folder
  with `tenant:` in `cavelon.yaml`. A token for a list of tenants still
  chooses one, with Enter taking the default the instance marks.

### Fixed

- `cavelon fmt` no longer adds a judge criterion's `dimension` to a test
  step's assertions (`{type: handoff_to, value: …}`) on an instance that
  describes a step's criteria; the instance refuses an assertion with a field
  it does not take. Where a value can take several shapes, `fmt` now picks the
  one whose `type` matches, and leaves a value that fits none as written.
- `cavelon validate` reports, where a value can take several shapes, only what
  the closest shape says (`missing required field "value"`) instead of every
  shape's complaint, and names a field that is not allowed (`field "agent" is
  not allowed here`).

## [0.1.4] - 2026-10-04

Agents keep to what is meant for them: `cavelon api` run by a coding agent
now applies the guards of the MCP tool, fields the instance marks as secret
are never sent from an agent, and every test-case status is explained.

### Added

- `cavelon explain` explains the test-case statuses that are neither pass nor
  fail: `calibration_required`, `pending_review`, `not_run`, `not_evaluated`
  and `skip`, with what each means and what to do next. They are no error
  codes, so the instance's error catalog does not list them.

### Changed

- `cavelon api` run by a coding agent applies the guards of the MCP `api`
  tool. `cavelon` sees an agent by the variable its shell tool sets
  (`CLAUDECODE`, `CODEX_THREAD_ID` or `CODEX_SANDBOX`, `CURSOR_AGENT`,
  `GEMINI_CLI`, `COPILOT_CLI`, `COPILOT_AGENT`, `AI_AGENT`), or by
  `CAVELON_AGENT=1`. There, it refuses an operation the instance keeps for a
  person, keeps its files in the solution folder, and for an operation that is
  not read-only prints the request with a token and sends exactly that request
  only when run again with `--confirm <token>`. A person's terminal is
  unaffected.
- The `api` tool, and `cavelon api` run by a coding agent, refuse a body that
  sets a field the instance marks as a secret value (`x-cavelon-secret`), in
  nested objects and arrays too, before sending anything
  (`secret_field_for_a_person`). An instance that marks no field behaves as
  before.
- `test run --wait` and `wait` print a short reason next to a count that waits
  for a person ("1 calibration required (a knowledge base or value the case
  needs was not ready)"), name the waiting cases with the reason the instance
  recorded, and say which `cavelon explain` to run. The cavelon-testing skill
  lists the statuses.
- The getting-started guide and the security page say which token ceiling to
  pick for which task (Observer, Builder, Tenant Owner, Platform mode only for
  platform operators) and to keep **May activate** off unless the token should
  put solutions live, and link the instance's page on personal access tokens.
- CI pins every action by commit, like the release workflow.

## [0.1.3] - 2026-10-04

The easy start: install with one line on macOS, Linux or Windows without
Node.js, `cavelon setup` sets up your coding agents and logs you in, and
tenants and solutions are chosen by name.

### Added

- `cavelon setup`: from "I have the kit" to "my coding agent can build a
  Cavelon solution" in one guided step. It finds Claude Code, Codex, Cursor,
  VS Code with GitHub Copilot, Gemini CLI and Kiro (their command on the `PATH`
  or their user settings folder), shows in plain words what it will change for
  each, asks once and does it: Claude Code and Codex get the Cavelon plugin
  through their own plugin commands; the others get the `cavelon` MCP server in
  their user MCP configuration and the skills in their user skills folder. The
  server starts as `cavelon mcp` when `cavelon` is installed, otherwise through
  `npx` (`cmd /c npx` on native Windows, where Claude Code and Codex also get
  the server next to the plugin). It changes only its own entries, leaves a
  `cavelon` server or skill file of yours alone, and records what it did, so a
  second run changes nothing. Then it logs in through `login`, choosing the
  tenant by name, and says the next step. `--check` reports each agent, starts
  the MCP server once and checks the login; `--remove` undoes exactly what
  setup did. `--agents`, `--instance` and `--yes` for use without a terminal;
  it is not an MCP tool.
- `cavelon` without Node.js: each release carries a standalone executable for
  macOS (Apple silicon and Intel), Linux (x64 and arm64) and Windows (x64),
  built with Bun from the tagged commit, with `checksums.txt` and a build
  provenance attestation per file (`gh attestation verify`). The executable
  keeps the token in the system's credential store, or in the user-only file
  where there is none, as the npm package does, and reads no `.env` or
  `bunfig.toml` from the folder it runs in.
- One-line install: `curl -fsSL https://github.com/goodguys-gmbh/cavelon-dev-kit/releases/latest/download/install.sh | sh`
  on macOS and Linux, `irm https://github.com/goodguys-gmbh/cavelon-dev-kit/releases/latest/download/install.ps1 | iex`
  in Windows PowerShell 5.1 or 7. The scripts pick the executable for the
  system, check its checksum, install it into the user's folder
  (`~/.local/bin`, `%LOCALAPPDATA%\Programs\cavelon`) without root, add that
  folder to the `PATH` once and say where, and print the next step. Running
  them again updates `cavelon`; `--version` (or `CAVELON_VERSION`) installs a
  given release. No telemetry.
- An update notice: when a newer release is out, `cavelon` says so after a
  command, at most once a day, with the one command that updates it the way
  it was installed (the install script again, into the same folder;
  `brew upgrade cavelon`; `winget upgrade goodguys.Cavelon`;
  `npm i -g @cavelon/cli`). It looks the release up on GitHub for the
  executables and on the npm registry for npm, anonymously, for at most 1.5
  seconds, and stays silent when that fails. Never with `--json`, in MCP mode,
  in CI, without a terminal or through `npx`; `CAVELON_NO_UPDATE_CHECK=1` turns
  it off.
- The release workflow builds, smoke-tests and attests the executables after
  staging the npm package, creates the GitHub release, and updates a Homebrew
  tap and writes a winget manifest once those are set up. macOS signing and
  notarisation and Windows signing run once their secrets are set
  (RELEASING.md); until then the executables are unsigned, and
  `docs/installation.md` says what macOS and Windows show for a file
  downloaded in a browser, and what to do.
- Choose a tenant and a solution from a list instead of typing a slug or id.
  `cavelon login` without `--tenant` reads which tenants the token reaches,
  where the instance lists them: it uses the only one and says so; with several
  it shows a numbered list on a terminal, and you type a number or part of a
  name; an operator's token that reaches every tenant asks for part of a name
  and searches. Without a terminal, `login` stores the token and prints one
  ready `cavelon use <tenant>` line per tenant (exit 2, `tenant_required`); a
  token that reaches no tenant is refused with `no_tenant_reached` (exit 7) and
  where to change it. An older instance that lists no tenants behaves as
  before.
- `cavelon use` without a tenant offers the same list; as the MCP tool
  `use_tenant` it returns the tenants as choices and changes nothing.
- `cavelon init` without `--harness`, on a terminal, offers the tenant's
  solutions or a new one by name, whose slug it derives and which it creates as
  a draft; without a terminal, the next steps list the tenant's solutions.
  Without `--tenant`, it asks for the tenant the way `login` does.
- `--tenant` takes a tenant's name, slug or id everywhere, resolved from the
  tenants the token reaches, and `--harness` a solution's name, slug or id. A
  miss names the closest tenants or solutions with the line to run for each.

### Changed

- `cavelon --version` adds how `cavelon` was installed and the command that
  updates it, on the lines after the version; the first line is still the
  version alone. `--version --json` adds `install` (`method`, `path`,
  `update`). The install scripts and the Homebrew formula's test read the first
  line.
- Docs: the README's first steps are now install, `cavelon setup`, and open a
  folder in your agent. Installation describes what `setup` changes for each
  agent and system, citing each agent's documentation; Building with a coding
  agent, Getting started, the MCP page, Security and the FAQ point to it.
- The plugin starts the `cavelon` on the `PATH` (`cavelon mcp`) when there is
  one, and `npx -y @cavelon/cli@0.1 mcp` otherwise, through `sh`. On native
  Windows, add the MCP server yourself as before, now simply
  `claude mcp add --scope user cavelon -- cavelon mcp` with the installed
  `cavelon.exe`.
- `cavelon init --update` keeps an MCP entry changed to start the installed
  `cavelon` (`cavelon mcp`) instead of `npx`, for a team without Node.js.
- Docs: the README's five-minute start begins with the one-line install per
  system, then the plugin, with `npx` and npm as the alternatives.
  Installation covers every way in (the one-line install with its options,
  checking the download, Homebrew and winget, npx and npm), updating and
  uninstalling each, and the proxy settings of the standalone `cavelon`.
- `tenant list` shows name, slug, role and id for every token, `whoami` shows
  the tenant's slug next to its name and id, and `init` writes `tenant: <slug>`
  into `cavelon.yaml` with a comment naming the tenant.
- The README, Getting started, Concepts, Troubleshooting, the FAQ, the
  examples' READMEs and the skills no longer ask for identifiers a person
  cannot find. The examples' READMEs said `cavelon whoami` shows the tenant's
  slug; `cavelon tenant list` does.

- Docs: the README's five-minute start, Installation, Getting started, the
  "before you start" part of Building with a coding agent and the FAQ start
  without a global install. With a coding agent, install the plugin, which runs
  `cavelon` through `npx` by itself; for the commands a person types, `login`
  first, run `npx -y @cavelon/cli <command>`. An alias (zsh, bash and a
  PowerShell function) or `npm i -g @cavelon/cli` is optional, with the
  `EACCES` fix for Node.js installed for the whole system. The docs say once
  that `cavelon` stands for `npx -y @cavelon/cli`, and the commands to type work
  as written in bash, zsh and Windows PowerShell 5.1 (no `&&` between
  commands; what to do when PowerShell refuses to run npm's scripts).

### Fixed

- `cavelon login` without `--tenant` no longer fails with "does not work in
  Platform mode" for a personal access token made for tenant work. It asks who
  the token is before anything else: a token the instance places in a tenant
  on its own (the one tenant it is limited to, or its owner's default) logs in
  and says which tenant it acts in. A token the instance cannot place is
  refused on every route without a tenant, so the instance names none of its
  tenants: `login` and `whoami` stop with `tenant_required` (exit 2) and ask
  for `--tenant <tenant-id>`, and any other command refused without a tenant
  says the same in its hint. A Platform-mode token logs in as before.
- `tenant_not_found` names your tenants by name and id (`details.tenants`
  with `--json`), so a slug the token cannot resolve leads straight to the
  name that works.

## [0.1.2] - 2026-10-04

A security release: upgrade if your coding agent uses `cavelon mcp`. It also
carries the fixes from a review of the whole CLI.

### Security

Upgrade to this version if your coding agent uses `cavelon mcp`.

- Over MCP, the `api` tool returns what it would send (method, path,
  parameters, body) and sends an operation that is not read-only only with
  `confirm: true`. It refuses, even with `confirm`, an operation that changes a
  secret, creates or revokes a credential (personal access tokens, API keys,
  sign-in) or decides an approval (`operation_for_a_person`). The CLI's
  `cavelon api` is unchanged. The server's instructions, `docs/mcp.md` and
  `docs/security.md` now say exactly which tools need `confirm` and which act
  at once.
- Over MCP, every path a tool takes (`api`'s `file` and `body` `@file`,
  `loop_start`'s `input` `@file`, `kb_upload`'s folder, `sandbox_seed`'s
  source, `artifacts_export`'s `out`, `init`'s `from`) must lead, after
  symlinks, into the solution folder (`path_outside_solution`), and never into
  `cavelon`'s config or cache directory (`path_in_kit_directory`). The CLI
  still takes any path.
- Every request URL is resolved before its origin is compared with the
  instance's (`foreign_url`), whatever its spelling, and a relative path
  outside the instance's base path is refused too.

### Added

- `cavelon validate --verbose` says which copy of the package schema it used:
  cached or read from the instance now, when, the instance version and the
  copy's hash; `--json` carries the same as `schema`.
- `docs/troubleshooting.md` has an Approvals section: the refusals of a
  decision by someone an approver rule does not name, and by the requester.

### Changed

- Over MCP, the `api` tool now refuses exactly the operations the instance
  marks for a person only in its OpenAPI (`x-cavelon-person-only`: setting or
  deleting a secret value, issuing, resetting or revoking a credential,
  deciding an approval), read-only or not, and the `operation_for_a_person`
  error carries the instance's reason (`x-cavelon-person-only-reason`, also in
  `details.reason`). On such an instance the words of the path no longer
  decide, so an operation the instance does not mark is previewed and sent
  with `confirm` like any other. An instance that marks no operation keeps the
  previous check by the words of the path. The contract snapshots are
  refreshed from a current instance.
- `examples/expense-approval/`: the approval says who may decide, by the
  policy's rule R8.1 and the amount (`approvers` in tiers: team leads, department
  heads, management), and that nobody decides their own request
  (`forbid_self_approval: true`). Its offline test checks both against the
  package schema.
- `docs/coding-agents.md`: the lesson "Enforce an approval rule through who may
  decide" now puts the rule on the Approval node (`approvers`,
  `forbid_self_approval`), tests that each tier reaches the approval, and lets
  a person decide once per branch; the example brief and the testing section
  say the same. The `cavelon-authoring` and `cavelon-testing` skills say it
  too.
- The contract snapshot is refreshed: the package schema types each node's,
  edge's and trigger's config and a test suite's settings, and the error
  catalog has the refusals of an approver rule
  (`approval_approver_rule_not_met`) and of self-approval
  (`approval_requester_cannot_decide`), which `cavelon explain` explains.

### Fixed

- A command run with `--env <name> --tenant <tenant>` acted in the `--tenant`
  tenant, but the commands it printed (the `--confirm` line of `limits set`,
  `models set-limit` and `apply`, `apply`'s `secrets set` and `variables set`
  lines, the `confirm` field in `--json` and over MCP) carried only `--env`, so
  running them acted in the env file's tenant, and an operator's one-tenant
  run cap became the platform's cap for every tenant. A printed command now
  keeps `--env`, `--tenant` and `--instance` as given.
- `--env <name>` without its `env/<name>.yaml` acted in `cavelon.yaml`'s tenant
  and reported success in every command but `apply` (`variables`, `secrets`,
  `models`, `limits set`, `activate`). Every command that takes `--env` now
  refuses it before anything is sent (exit 2) and names the env files the
  solution has.
- A member's personal access token could not use a tenant's slug when the
  tenant's name differed from it (`init --tenant acme`, `use acme`,
  `cavelon.yaml`'s `tenant: acme` failed with `tenant_not_found`): only the
  names in the memberships were compared. The slug is now read from the
  tenant's own detail (`GET /api/v1/tenants/{tenant_id}`), which a member who
  may view the tenant's settings reads; otherwise the error says to use the
  name or the id.
- `--instance` did not override an unusable `CAVELON_URL` or `cavelon.yaml`
  instance (plain http to a remote host, for example): every command,
  `login` and `logout` included, failed on the URL it was not going to use. A
  URL is now checked only where it is the one chosen.
- On an instance older than the `/api/v1/meta` routes, which answers them 404
  before it checks the caller, `login` stored a wrong API key as a successful
  login. It now checks such a key with one authenticated read and refuses it
  on a 401.
- The contract cache kept instances apart by host, port and path only, folded
  together: `host:8443` and `host/8443`, `/team/a` and `/team_a`, and http and
  https shared one cache, so one instance's OpenAPI could be used against the
  other. Each instance's folder now ends in a hash of its URL; the old folders
  are no longer read (the next online command fills the new one) and can be
  deleted.
- `cavelon wait`, `watch` and `test run --wait` passed a test run that measured
  nothing: they read only the failed and errored counts. They now read every
  count the run's summary carries. Steps or cases not run, technical errors,
  missing results, and a run the instance marks not comparable (or, on an older
  instance, one without a pass rate) exit 1 with the counts named; answers that
  wait for a manual verdict or a value a case needs exit 5. `failed_results`
  carries `counts`, `comparable`, `non_comparable_reasons` and `exit_code`.
- `cavelon loop start` sent no `Idempotency-Key`, so the retry its timeout
  asked for started a second run. It now always sends one
  (`--idempotency-key`, a new UUID by default; `--json`: `idempotency_key`),
  and an exit-8 error of `loop start`, `loop pause`, `loop resume`,
  `sandbox refresh` and `artifacts export` names the key to retry with.
- On an instance that does not serve its OpenAPI, `loop pause`, `loop resume`,
  `sandbox validate`, `sandbox refresh`, `sandbox seed` and `artifacts export`
  failed with exit 3: their `Idempotency-Key` and `If-Match` are now sent as
  headers.
- A response whose body stalled or broke off gave `internal_error` (exit 1);
  it is now `request_timeout` or `network_error` (exit 8), and `kb upload`
  reports the batches it had uploaded.
- `cavelon limits` (and the MCP tool) failed with exit 8 when only the quota
  use could not be read; it now shows the limits, with
  `tenant_quotas.unavailable` saying why the quotas are missing.
- `cavelon limits --json` on an instance older than the limits had no
  `quota_values`; it now has the same keys as on a current instance.
- `cavelon limits set monthly_processing_step_cap` with no cap set previewed
  `0 → none` and reported a change it did not make. It reads the published
  value, takes a cap of 0 as none, and says it is already none; `changed` now
  follows what the instance reports.
- `docs/limits.md` gave `request_invalid` (exit 3) for a value of the wrong
  kind; such a value is a usage error (exit 2), and only a value out of bounds
  is `request_invalid`.
- `cavelon trace <operation>` refused the operation `loop start` prints; it now
  reads the trigger run's traces.
- `pull` outside a git repository overwrote local edits and deleted test
  suites that were never applied, without a word: its check for uncommitted
  changes needs git. Outside git it now refuses (exit 4,
  `uncommitted_changes`) to overwrite or remove a package file that changed
  since the last pull, unless `--force`; a file no pull wrote counts as
  changed. `pull` records each file's digest in `.cavelon/` for this.
- A symlinked package or suite file was silently left out of `validate` and
  `apply` (with `--mode replace`, the import then deleted its section), and
  `pull` replaced the link with a file. A link inside the solution folder is
  now read as its file and `pull` writes through it; a link out of the
  solution folder is a `package_file_invalid` error, and `pull` and
  `init --from` refuse to write through one (`package_file_outside`).
- A package file saved with a UTF-8 byte-order mark (Windows PowerShell 5.1,
  older Notepad) failed `validate` and `apply` as invalid YAML or JSON. The
  mark is now ignored when the file is read, also by `init --from`.
- After `init`, `validate` and `apply` did not say that the solution has no
  package files yet (the empty `tests/` folder counted as one); `apply` failed
  with a schema error instead of exit 2 and the hint to `pull`. A folder of the
  layout now counts once it holds a package file, and an empty `tests/` no
  longer clashes with a `package/test_suites.yaml`.
- `init --hook` wrote into the folder a global `core.hooksPath` names, so
  every repository of the user ran the solution's check. It now leaves a
  hooks folder outside the repository alone and says why; one inside it (as
  husky sets) is used as before.
- On native Windows, the MCP entry `init --agents` writes started `npx`
  directly, which an agent that starts servers without a shell cannot run.
  Run on Windows, it now writes `cmd /c npx …`, and `init --update` keeps an
  entry written on another system. The installation guide shows how to add
  the server on Windows when the plugin's `npx` entry cannot start.
- On a development build of the instance, which keeps one version while its
  package schema changes, `cavelon validate` used the schema it cached first
  until the cache was removed. It now reads a development build's schema,
  error catalog and capabilities again once its copy is a minute old, checks
  a copy with the ETag the instance sent when there is one, and with
  `--offline` or an unreachable instance uses the old copy and says so. The
  other cached contracts of a development build (OpenAPI, docs index) follow
  the same minute; `CAVELON_CONTRACT_TTL_SECONDS` sets it. A release's copies
  are kept as before.
- `cavelon validate --json` reported `warnings` as the number of warning
  findings, but as the list of messages when a warning about the run fired
  (a stale or missing copy of the schema, for example), so a program could not
  rely on its type. `warnings` is now always a list of `{code, message}`
  objects: the warning findings, then the warnings about the run with `code`
  null. The count moved to the new `warning_count`, which counts both;
  `error_count` joins it, and `errors` keeps its number. The MCP tool
  `validate` returns the same. Every other command's `warnings` was already a
  list of messages; the command reference now says so.

## [0.1.1] - 2026-10-03

The first release built from the public repository: with provenance on npm,
and without source comments in the package.

### Added

- **User documentation** in `docs/`: installation, a getting-started tutorial,
  concepts, the command reference (generated from the commands' own help, and
  checked in CI), the MCP server, limits, troubleshooting, security and an FAQ.
  The README is now the landing page that links them.
- `CONTRIBUTING.md` for contributors.
- **Building a solution with a coding agent** (`docs/coding-agents.md`): what
  the agent does and what stays with you, briefing it with example briefs, the
  loop as the agent runs it, reviewing and testing its work, lessons from real
  runs, and prompts to copy. The README, installation, getting-started and FAQ
  pages link it.
- `cavelon activate` prints each readiness check with its result and every
  warning, in its text and in `--json` (`checks`, `warnings`).
- `cavelon trace <test run>` shows the judge's reasoning for every judged case,
  a pass included, when the instance returns it.
- `cavelon test run --wait` ends, when the wait runs out first, with one line
  that says how to resume, with the same `--timeout`.
- `cavelon validate` warns (`knowledge_base_without_search_tool`) when an agent
  is given knowledge bases, by a skill or on a tool assignment, but no search
  tool reaches it, so it cannot search them.
- `examples/expense-approval/`: a pipeline (chat, agent, router, policy check,
  decision memo, approval by a person, outcome) with a short fictional travel
  and expense policy and a test suite that reaches the approval.
- The `cavelon-testing` skill says how an approval is tested: a test run
  records that it was reached, with its title and instructions, and the judge
  grades that; the branches after a person's decision stay untested.

### Changed

- The contract snapshots live in `contracts/cavelon/`. The OpenAPI snapshot
  holds only the operations the kit uses (`contracts/kit-operations.json`), and
  `cli/scripts/trim-openapi.mjs` and `cli/scripts/scrub-contracts.mjs` keep it
  that way on every refresh.
- The published package carries no source comments.

### Fixed

- `cavelon trace` prints each drill-down command with the id its route needs,
  labelled (a case's conversation id, a trigger case's run id, the trace id),
  and a wrong id's 404 answers with a hint naming the id to use.
- The `support-faq` example's skill now carries the search tool
  (`search_documents`); before, its agent had a knowledge base but nothing to
  search it with.

## [0.1.0] - 2026-10-03

The first release: everything a developer needs on day one to build a
Cavelon solution from a repository with Claude Code or Codex.

### Added

- **The `cavelon` CLI**, on npm as `@cavelon/cli` (`npm i -g @cavelon/cli` or
  `npx -y @cavelon/cli`), with provenance:
  - session: `login` (the token from the terminal or stdin, never an argument,
    kept in the system's credential store), `logout`, `whoami`, `use`, `status`;
  - solution as code: `init`, `init --from <file>` (a package file into the
    solution's layout), `pull`, `validate`, `apply` (a preview with an id, then
    `apply --confirm <id>`; a draft it creates takes the package's harness
    name), `activate` through the readiness gate, `explain <code>`;
  - tenants and solutions: `tenant create|list`, `harness list|new|clone`;
  - seeding and testing: `kb upload`, `test run`, `wait`, `watch`, `trace`;
  - variables and secrets: `variables list|get|set|delete`,
    `secrets list|set|delete`;
  - limits and capacity: `limits`, `limits set`, `models list`,
    `models set-limit`, and "waiting for run capacity" on queued runs;
    `limits` shows the monthly Processing Step cap with this month's use
    and branch concurrency; `limits set`
    changes the cap (a Tenant Owner's), sends an operator's run cap change in
    Platform mode with the role it names, `--tenant` for one tenant's own cap
    and the tenant's flag behind concurrent branches, and refuses a credential whose published permissions lack the
    change's before sending; `validate` warns on a `max_concurrency`
    above the branch width and on fan-outs that run in sequence; `explain
    processing_step_cap` explains the refusal at the cap; `kb upload` reads
    archive uploads from their own switch, `kb_upload_archive_enabled`, and
    skips a limit whose `binds_when` entry is off; `limits` says which limits
    bind only while another is on; `limits set` changes the switch and the
    per-visitor rate limits; a value above a platform ceiling is refused as
    `limit_above_platform_ceiling`, which `explain` covers;
  - long-running work: `loop start|watch|iterations|pause|resume|cancel`,
    `trigger identity`, `sandbox …`, `artifacts export`;
  - knowledge: `docs search|get`, and `api` for every operation the instance
    publishes;
  - built for agents: `--json` everywhere, no prompts, bounded waits and output,
    documented exit codes, every command marked read-only or changing.
- **`cavelon mcp`**: the same commands as MCP tools over stdio, with read-only
  and destructive annotations.
- **The Cavelon plugin for Claude Code and Codex** in `plugin/`, with this
  repository as the marketplace of both: the skills `cavelon-loop`,
  `cavelon-authoring`, `cavelon-testing` and `cavelon-long-running`, and the
  `cavelon mcp` server, started as `npx -y @cavelon/cli@0.1 mcp`.
- **`cavelon init --agents <list>`**: the same skills and MCP entry written into
  a solution folder, for agents without a plugin system.
- **`examples/support-faq/`**: a small solution repository to copy and try.
- `README.md` with the five-minute start, `SECURITY.md`, `RELEASING.md` and
  this changelog.
- **A clear refusal when an instance has personal access tokens off:** the
  token is reported as `personal_access_tokens_disabled`, naming the
  operator's setting `PERSONAL_ACCESS_TOKENS_ENABLED`, instead of as expired
  or revoked. The README's step 2 says the
  instance needs personal access tokens and the operations API turned on.
