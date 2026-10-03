# Changelog

All notable changes to the Cavelon dev-kit are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project uses [semantic versioning](https://semver.org/): one version for the
CLI, the skills and the plugin.

## [Unreleased]

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
