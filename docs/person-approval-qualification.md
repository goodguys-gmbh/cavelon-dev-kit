# Supervised person-approval fixture

This repository fixture prepares a loopback fake instance and two child
solutions. The review import deletes a synthetic obsolete agent and changes a
synthetic saved-query limit from 5 to 10. It runs no model or database and needs
no tenant, account or credentials. It reuses generated client setup and the
candidate's bundled adapters; it adds no approval-answer tool.

The maintained routes are the person's own terminal for all seven setup
clients, and fixed no-model calls through Pi/OMP's actual native TUI extension
host. Other native dialogs and editors need their own host drivers and evidence.
An own-terminal check with OpenCode, Pi, Kilo, Goose or OMP does **not** qualify
that client's native dialog. Existing 0.1.17 Linux acceptance remains unchanged;
[#192](https://github.com/goodguys-gmbh/cavelon-dev-kit/issues/192) stays open.

## Prerequisites and safety checks

Use a fresh clone on the host being checked, Node.js 20.3 or newer, local npm
dependencies and a Cavelon standalone executable for that platform. The tooling
is source-repository tooling, not a new installed CLI command. Run from the
repository root; the same Node commands work in POSIX shells, PowerShell and
cmd.exe. Quote paths that contain spaces.

```text
npm --prefix cli ci --ignore-scripts
npm --prefix cli run build
cd cli
npx vitest run test/approval-qualification.test.ts test/native-approval.test.ts test/mcp-solution-directory.test.ts --maxWorkers 2
cd ..
node cli/scripts/qualify-approval.mjs
```

These checks use **simulated** UI answers and the locally built CLI. They cover
refusal, strict boolean answers, missing UI, headless mode, sibling selection,
abort/late answers, preview expiry, fresh approval and exact request binding.
The adjacent native protocol tests also cover dialog timeout/disconnect.
They open no live person form. Evidence is retained under
`.wt/approval-qualification-tests/<process-id>/evidence.json`; do not relabel it
as actual-person evidence.

## Start a supervised own-terminal check

Prepare an unused run directory and supply the actual installed standalone
executable. For example, on native Windows use `cavelon-windows-x64.exe`; on
macOS use the executable for the host architecture. No runtime is downloaded
by the supervisor.

```text
node cli/scripts/qualify-approval.mjs start --client cline --route terminal --executable "path/to/cavelon" --run .wt/person-terminal
```

The supervisor isolates profiles and synthetic credentials under the run's
`private/`, generates setup, then checks the agent/headless and sibling routes.
Both must send zero confirmation requests and imports. It prints a command for
the person to run in a **separate own terminal**, outside the coding agent:

```text
node cli/scripts/qualify-approval.mjs terminal --run .wt/person-terminal
```

The first phase displays the exact preview and requires the person to type
`decline`. It sends no nonce or import. The supervisor then makes a fresh
preview. Run the printed terminal command again, review the new preview and
type `apply` only if you intend to execute that exact fake import. The helper
runs `cavelon apply --confirm <preview> --env test --json` in the selected child
with its isolated fixture environment. It refuses marked agent or noninteractive
terminals before using that environment. Do not remove markers to bypass this
guard. A phase has an exclusive one-use lock; interrupted phases need a new run,
not a retry that could share an earlier answer.

The supervisor accepts only one correctly bound confirmation and import, the
review harness, the deletion and query limit 10. It stops after completion,
abort, client exit or its deadline (default 20 minutes; `--deadline-seconds`
accepts 5..1200). Ctrl+C cancels supervision. Failed evidence remains in
`failure.json`; a failed run is never an accepted platform check.

## Start a supervised Pi/OMP native check

Provision the pinned client separately using the existing
[runtime provisioning](../CONTRIBUTING.md#released-coding-client-runtimes).
Use `.wt/client-runtime/pi` or `.wt/client-runtime/omp`, or supply `--runtime`
with the provisioned directory. OMP also needs its pinned Bun 1.3.14 executable
via `--bun`. Provisioning may fetch public packages; the supervisor itself
does not fetch a client, adapter dependency or model.

Run the supervisor from the person's own interactive terminal on the host to
be checked. Starting this route opens real, expiring native forms, so coordinate
the operator's availability first:

```text
node cli/scripts/qualify-approval.mjs start --client pi --route native --executable "path/to/cavelon" --runtime .wt/client-runtime/pi --run .wt/person-pi
node cli/scripts/qualify-approval.mjs start --client omp --route native --executable "path/to/cavelon" --runtime .wt/client-runtime/omp --bun "path/to/bun" --run .wt/person-omp
```

Run one command at a time. The driver loads the **unmodified** setup-installed
extension, registers its tools with the released TUI host and invokes fixed
preview/import calls. It observes `ui.confirm` but returns only the host's
actual answer. No provider prompt, API key or scripted acceptance is supplied.
First choose No, including on a preview continuation page if shown. The
supervisor verifies zero nonces/imports, then invokes a fresh change. Review all
preview pages before choosing Yes in the final exact-change dialog. Continue
on a preview page does not approve the change. Abort, timeout, missing UI or
session shutdown must remain safe; do not retry a dispatched change automatically.

## Review and export evidence

```text
node cli/scripts/qualify-approval.mjs check --run .wt/person-terminal
node cli/scripts/qualify-approval.mjs attest --run .wt/person-terminal
node cli/scripts/qualify-approval.mjs check --run .wt/person-terminal
```

`check` recomputes the machine-readable invariants and writes `export.json`.
Request binding uses the fake instance's canonical JSON and normalized
method/path semantics, so reordered object keys preserve the same change.
The operator attestation digest intentionally binds the exact complete
evidence JSON, including its ordering.
Exit 0 means valid simulated evidence or valid operator-attested person
evidence; exit 2 means the binding checks pass but the actual-person observation
is still unattested; exit 1 means failure. Inspect `provenance`, not just the
exit code. `attest` requires the person's interactive terminal and a freshly
typed statement bound to the entire evidence digest, followed by the actual
host surface. Changed evidence invalidates the attestation. Simulated evidence
cannot be attested into person evidence.

The evidence records the candidate version/hash, pinned client version,
platform/architecture, route, refusal codes, native dialog observations, exact
synthetic request bodies and result. Confirmation binding proves the token,
tenant and exact request relationship. It does **not** prove a person's approval;
the distinct operator attestation records who observed the interaction without
asserting independently authenticated identity. `operator_attestation_valid`
means the local digest and declared route match, not that a person's identity
or answers were independently verified. `operator_attested_coverage` distinguishes
`native-ui` from `own-terminal`; the conservative `actual_person_ui` stays false.
Every export keeps `platform_acceptance: requires-maintainer-review`.

Attestation is qualification bookkeeping after the fixture completes. It is
never an additional approval step for ordinary kit changes, and does not
replace the fresh UI/own-terminal answer required before the import.

For the terminal route the client name is the generated setup target, not
evidence of a running client: `pinned_client_version` names the intended runtime;
`client_version` is recorded only after the native route checks it. `check`
also requires successful supervisor and cleanup completion for observed runs.
Cleanup requires a positively observed owned-child exit after the bounded
termination attempt. A failed Windows taskkill or unobserved POSIX exit fails
closed, even when sending the termination command appeared to succeed.

Keep the run directory until review. Only `export.json` is intended for sharing:
`private/`, setup diagnostics and terminal-session files contain local paths and
synthetic credentials and must stay local. Review exported synthetic bodies and
operator-supplied host text before publishing. Store screenshots or a person-owned
terminal transcript separately when the reviewer needs direct interaction evidence.

## Remaining host gates

| Surface | Prerequisite still needed for acceptance |
|---|---|
| Native Windows | Windows host, matching standalone/client runtime, own interactive terminal and person; Pi/OMP TUI behavior observed there |
| WSL | Actual WSL distribution and terminal, Linux executable/runtime inside it, person; record WSL separately from native Windows and Linux |
| macOS | macOS host and matching architecture, standalone/client runtime, interactive TUI and person |
| OpenCode/Kilo/Goose native UI | Released interactive client on each target host and a maintained no-model host driver or separately supervised invocation; these routes are not driven by this fixture |
| Cline/Kilo/other editors | Exact editor/extension versions, isolated real editor host, generated settings and person-owned terminal where required; a CLI check does not qualify the editor |

No Windows, WSL, macOS or editor acceptance is inferred from headless tests,
an attestation alone, related-client behavior or existing Linux evidence, or
from a kit version: releasing 0.2 leaves these gates as they are.
Customer model/network policy and database behavior need separate pilots; the
[customer pilot](customer-pilot.md) checklist and report template record them
with the same labels: automated, simulated or actual person.
