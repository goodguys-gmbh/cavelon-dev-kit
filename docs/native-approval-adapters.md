# Native approval adapter design

Prototype decision for [#193](https://github.com/goodguys-gmbh/cavelon-dev-kit/issues/193),
part of [#192](https://github.com/goodguys-gmbh/cavelon-dev-kit/issues/192).
Kit 0.1.16 installs bundled OpenCode/Pi native adapters. Their built-in MCP
route still uses the person's separate terminal for guarded changes. See the
[qualification matrix](coding-agent-qualification.md) for current packaged
client evidence; the prototype record below is historical. Unreleased Kilo
support adds its own server/TUI entry points and configuration ownership.

## Decision

Pursue native exact-change approval through the clients' extension systems.
Their inspected built-in MCP clients lack the required form capability, but
both native UI prototypes completed Cavelon's existing elicitation exchange.
No upstream change is needed to establish this initial native path.

Keep one Cavelon MCP server and one guarded-change implementation. The adapter
owns its connection and forwards the exact preview message. Only a fresh boolean
`true` from the native person UI can accept that call's form. Generic permission
or an agent-supplied argument cannot supply the answer. There is no approval-answer
tool, remembered approval or automatic retry.

The instance binds its confirmation to the token, tenant and exact request; it
does not verify the person's answer. Database passwords, privilege acknowledgement
and **Allow write queries** remain person-only in the Admin.

Use the maintained [person-approval supervisor](person-approval-qualification.md)
for portable fake-instance checks on another host. It keeps simulated protocol
evidence, observed binding and operator-attested person provenance distinct,
and drives the existing Pi/OMP bundled adapters without supplying UI answers.
Other native/editor host prerequisites remain explicit qualification gates.

## Prototype evidence

Released Linux clients, a fake local instance and fixed tool calls were used,
with no model/provider call. The maintainer operated the native dialogs.

| Check | OpenCode 1.18.35 | Pi 1.1.0 |
|---|---|---|
| Actual extension loading | Server and TUI plugins | Native TypeScript extension |
| Tools and read | 64 tools; `whoami` | 64 tools; `whoami` |
| First person answer | Native Cancel | Native No |
| Refusal | No confirmation request or mutation | No confirmation request or mutation |
| Fresh second answer | Native Confirm | Native Yes |
| Accepted change | One confirmation and synthetic deactivation | One confirmation and synthetic deactivation |
| Exact binding checked | POST, previewed harness path, null body | POST, previewed harness path, null body |
| General permission | `allow`; Cavelon still asked | Explicit native dialog per change |

The private prototype passed 17 automated checks across the shared protocol,
the actual Pi loader and a simulated OpenCode UI API. They cover strict answers,
refusal, cancellation, timeout, late answers, concurrency, session changes,
disconnect and headless fallback. Simulated dialogs prove protocol behavior,
not person interaction.

The reusable transport is in `cli/src/native-approval/client.ts` with
fake-instance tests in `cli/test/native-approval.test.ts`.

The adapter sources build self-contained native entry points: separate
OpenCode server/TUI modules, a Pi extension and unreleased Kilo server/TUI
modules. npm carries
the versioned assets and their dependency licenses, hashes and manifest;
standalone builds embed the same bytes for setup. The packaged adapters load
from a directory without `node_modules`. `setup` and `init` install
these assets, profiles and exact client references without fetching a runtime
dependency. Packaged-client qualification is recorded in the
[release matrix](coding-agent-qualification.md); broader qualification stays
tracked in #201.

Each adapter reads its adjacent `profile.json`; OpenCode also accepts an
explicit profile path in plugin options. The profile names the selected existing MCP
configuration and stores a hash of its disabled Cavelon entry. It copies no
credential or command environment values. A changed or re-enabled entry refuses
native startup so duplicate built-in Cavelon tools cannot silently take over.
Other MCP servers keep their own configuration.

Project profiles use format `2`: their configuration and project-root paths
are relative to the profile, with forward slashes, so moving a clone does not
keep a path to the original machine. The configuration must remain inside the
project after symlink resolution, and the native server and UI must run in the
matching project workspace. Pi still requires the person's project trust.
Existing absolute user profiles remain readable. Profiles bind configuration;
they neither contain credentials nor represent a person's change approval.

The configuration editor adds and removes individual native plugin/extension
array members while preserving other members and comments. Duplicate owned
members, invalid lists and edits that would remove a personal comment are
refused. Automatic native setup records file hashes, exact references and the
selected MCP config in `installation.json`. It prepares all edits before
writing, locks its installation directory, refuses concurrent configuration
changes, and rolls back only bytes it actually wrote when a write fails.
Update/check/removal refuse edited
assets or references, including additional absolute/file-URL aliases.

User assets live in the selected client directory's `cavelon/`; project assets
live in `.opencode/cavelon/`, `.pi/cavelon/` or `.kilo/cavelon/`. A verified user installation can
serve a new project without duplicate project files. If both adapters already
exist, a valid project profile owns its workspace and the user adapter yields;
Pi requires project trust before this precedence applies. OpenCode's generated
entry wrappers use distinct user/project plugin IDs. Setup respects a person's
disabled plugin, and removal keeps unrelated settings and files.

OpenCode's server and TUI references follow separate configuration precedence.
`OPENCODE_TUI_CONFIG` does not come from `OPENCODE_CONFIG`; a higher-precedence
directory or changed reference location is diagnosed rather than duplicated.

The OpenCode server exposes `cavelon_<tool>` names. Private IPC exposes only
session discovery and tool calls, never an approval answer. It refuses multiple
matching TUIs and unsafe paths, decodes split UTF-8 frames, bounds frame size,
uses short Unix socket paths or Windows named pipes and removes its descriptors
on shutdown. A dispatched failure is never retried through the headless route.
Pi uses `mcp__cavelon__<tool>` names, current TUI context, project trust and
fresh connections after session shutdown/restart. RPC/headless modes keep the
person-terminal route; a duplicate Cavelon tool owner is refused.

Long previews are shown in bounded native pages before a final fresh approval.
Continuation through a preview page does not approve the guarded change. A
refusal, close, abort or changed session cancels it. Automated packaged-runtime
and lifecycle checks use simulated UI callbacks; actual packaged-client loading
and supervised person interaction are recorded separately in the
[qualification matrix](coding-agent-qualification.md).

## OpenCode

Package separate server and TUI entry points. The server registers Cavelon
tools; the TUI owns the MCP connection and uses `DialogConfirm`. Avoid
`context.ask`, whose generic permission can be remembered or automatically allowed.

The prototype uses private local IPC to discover the displayed session and
invoke a tool. There is no approval-answer operation. Exactly one TUI must
display the requested session. Disconnect or session change aborts pending
work. Missing or multiple matching TUIs cannot choose a person implicitly.

Before dispatch, missing UI permits a separate headless connection for reads,
previews and the existing exact person-terminal route. After dispatch, a
disconnect has an unknown outcome: never retry the change through fallback.

Before shipping, qualify private descriptor/socket cleanup, Windows named
pipes, Unix socket path limits, multiple workspaces and complete long previews.
Use the Cavelon tool namespace. Setup must manage both plugins and prevent
duplicate built-in Cavelon tools while preserving unrelated servers/plugins.

## Pi

An extension owns the MCP connection and registers Cavelon tools. Use
`ctx.ui.confirm` only when the current call has both `ctx.hasUI` and
`ctx.mode === "tui"`. RPC/print/headless input cannot substitute for a person.
Close resources on `session_shutdown`; cancellation or timeout closes the
affected connection so a late answer cannot authorize a later call.

The isolated prototype disabled built-in MCP. Production must preserve unrelated
servers and select ownership only for Cavelon; current Pi supports per-server
`enabled`. Keep its canonical tool namespace, project trust, configuration
precedence and `PI_CODING_AGENT_DIR`. Diagnose old replacement `/mcp` extensions
rather than installing another general MCP replacement.

Before shipping, qualify reload/new/resumed sessions, ownership, extension
conflicts and coexistence with an unrelated native MCP server.

## Kilo

The released Kilo 7.8.8 v1 tool and TUI dialog contracts match the shared
OpenCode transport. Kilo has separate entry points, client identity, user/project
plugin IDs and profiles; it does not inherit OpenCode's configuration resolver
or qualification. Its own native config chain includes compatible files and
managed policies, which setup inspects without migrating another client's
Cavelon binding.

Kilo notifies plugins of its merged configuration through the `config` hook.
The native server retains that config and verifies the current Cavelon entry's
hash before every dispatch, including changes made by later plugin hooks.
Calling the SDK config endpoint during plugin initialization would re-enter
that initialization, so the adapter uses the supplied hook instead. A missing
or changed effective binding refuses tool dispatch. The server's `shell.env`
hook marks agent commands; a process-scoped guarded launch remains required
when that plugin is unavailable.

The CLI TUI provides the same fresh exact-change dialog, session confinement
and refusal behavior. The current editor uses the backend server plugin but
has no matching TUI owner; guarded changes return the person's terminal route.
The packaged Kilo 7.8.8 CLI passed fresh person Cancel/Confirm: refusal made
no confirmation or mutation, and the new approval applied one bound synthetic
child-solution import. Full offline journeys remain a release gate, tracked
separately from runtime loading and person interaction in the
[qualification matrix](coding-agent-qualification.md).

## Packaging and completion gates

Ship versioned native assets with the kit, with their MCP client dependency
bundled. Setup/runtime must not fetch a package or community extension. Use the
already-provisioned client runtime and the ordinary platform-aware installed
`cavelon mcp` command. Keep the four authoritative skills.

Carry assets in npm and embed them in standalone executables for setup. Extend
deterministic plugin rendering, hashes and the existing signed offline/release
artifacts without assuming a new instance manifest contract. Setup/check/update/
remove must preserve personal edits, unrelated configuration and formatting.

The adapters, setup lifecycle, shell guards and bundled dependencies are part
of 0.1.16. The [qualification matrix](coding-agent-qualification.md) separates
automated checks from real-client loading and person interaction. Native UI
checks on additional operating systems and customer model/network pilots remain
separate work; no qualification is inherited from a related client.
