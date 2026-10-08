# Native approval adapter design

Prototype decision for [#193](https://github.com/goodguys-gmbh/cavelon-dev-kit/issues/193),
part of [#192](https://github.com/goodguys-gmbh/cavelon-dev-kit/issues/192).
Native adapter installation remains in development. Existing built-in MCP setup
for these clients uses the person's separate terminal for guarded changes. The
prototype evidence does not change released support.

## Decision

Pursue native exact-change approval through both clients' extension systems.
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
fake-instance tests in `cli/test/native-approval.test.ts`. This foundation is
not itself an installed client adapter.

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

## Packaging and completion gates

Ship versioned native assets with the kit, with their MCP client dependency
bundled. Setup/runtime must not fetch a package or community extension. Use the
already-provisioned client runtime and the ordinary platform-aware installed
`cavelon mcp` command. Keep the four authoritative skills.

Carry assets in npm and embed them in standalone executables for setup. Extend
deterministic plugin rendering, hashes and the existing signed offline/release
artifacts without assuming a new instance manifest contract. Setup/check/update/
remove must preserve personal edits, unrelated configuration and formatting.

The prototype decision is complete. Production adapters, safe setup lifecycle,
real packaged loading, shell guards, full solution journeys, Windows/macOS
qualification and offline consumer checks remain open. Advertise native approval
only for the exact packaged client version, mode and platform whose checks passed.
