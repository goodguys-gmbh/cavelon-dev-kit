# Changelog

All notable changes to the Cavelon dev-kit are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project uses [semantic versioning](https://semver.org/): one version for the
CLI, the skills and the plugin.

## [Unreleased]

### Added

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
