# Coding-agent qualification

Setup support and real-client qualification are recorded separately. Version
0.1.16 adds the three open-source clients below. Unreleased Cline and Kilo
checks are recorded separately; Goose and OMP remain planned. Existing clients
keep their installation routes.

| Client | Pinned version | Runtime checked | Guarded-change mode |
|---|---|---|---|
| OpenCode | `opencode-ai` 1.18.35 | Linux x64; packaged native Cancel/Confirm | Bundled server/TUI plugins; fresh native dialog |
| Pi | `@earendil-works/pi-coding-agent` 1.1.0 | Linux x64; packaged native No/Yes | Bundled extension; fresh native TUI dialog |
| Qwen Code CLI | `@qwen-code/qwen-code` 0.25.0 | Linux x64 settings, skills, MCP transport, shell and person-terminal import | Person's own terminal; no native Cavelon dialog |

The automated kit matrix covers Node.js 20/22/24, Linux, macOS and Windows,
all five standalone builds, installation, packaging and ownership lifecycle.
That does not certify each client's UI on every operating system. Native
macOS, Windows and WSL client UI checks and customer-specific model/network
pilots remain separate qualification work. Qwen editor surfaces are outside
this release's scope.

Client checks use a fake local instance and synthetic data, with no model
calls or real database execution. Programmatic fixture calls prove transport
and behavior. Scripted UI responses never count as a person's approval.
The packaged OpenCode, Pi and Qwen checks opened a multi-solution root, validated
a child package and previewed an import that deletes a synthetic agent and
changes a synthetic saved query. OpenCode and Pi refusals sent no confirmation or
import. Their fresh native approvals and Qwen's person-run terminal command each
sent one confirmation bound to exactly one import. Qwen's agent and sibling
preview paths refused. No script supplied a person's answer.

The locally built offline bundle was extracted and installed in a clean
private directory. With its executable on PATH, each pinned client loaded
setup's local assets and completed a fixed draft workflow: validate, preview,
import, start a synthetic suite, wait and inspect its trace. A bounded prompt
edit repeated that workflow. These ordinary draft imports needed no person
approval; guarded changes were checked separately above. OpenCode and Pi used
their actual server/TUI and extension hosts. Qwen used its released MCP client
and settings loader with minimal host registry stubs. No runtime package fetch
is required by the bundled adapters; external-egress/customer policy pilots
remain separate work.

Model quality and a customer's complete deployment need their own evaluation.

Multi-solution checks start the MCP server at a root `cavelon.yaml` without a
harness. Child folders have separate configuration, environments and previews.
Use `solution_dir` on each call; `harness` alone does not select a folder.
Sibling previews refuse, and guarded imports retain their selected directory.

Offline setup uses a provisioned Cavelon executable on PATH. Native adapter
protocol dependencies and all four skills are bundled. Provision the coding
client and model runtime separately; the instance's execution provider is a
separate setting. See [offline installation](offline-bundle.md).

Installation and lifecycle instructions: [OpenCode](install/opencode.md),
[Pi](install/pi.md), [Qwen Code](install/qwen-code.md). The
[native adapter design](native-approval-adapters.md) explains exact-change
approval, refusal and failure behavior.

## Unreleased Cline integration

| Surface | Pinned version | Runtime checked | Guarded-change mode |
|---|---|---|---|
| Cline CLI | `cline` 3.0.70 | Linux x64 released binary; four skills, native MCP read, child-solution deleting preview, headless/sibling refusal and inherited guarded shell | Person's own terminal; no native Cavelon dialog |
| Cline VS Code | `saoudrizwan.claude-dev` 4.1.23, VS Code 1.139.1 | Linux x64 actual isolated extension host; default shared settings, four native skills, native MCP read, child-solution deleting preview and headless/sibling refusal | Person's own terminal; no native Cavelon dialog |

The CLI uses a scripted loopback model endpoint to exercise its actual tool
dispatch; no real model provider is called. The editor loads the released VSIX
in VS Code with a small inspection facade for its existing controller, rather
than replacing the editor or MCP implementation. These checks send no guarded
confirmation or import and do not supply a person's answer.

Use the editor's default shared paths and launch a fresh process from the
repository root. Its legacy compatibility UI has separate custom-path limits,
and its MCP environment filters custom Cavelon state paths; see
[Cline](install/cline.md). Packaged own-terminal approval and complete offline
workflow qualification remain release gates. Other platforms, editor variants
and customer model/network pilots remain separate work.

## Unreleased Kilo integration

| Surface | Pinned version | Runtime checked | Guarded-change mode |
|---|---|---|---|
| Kilo CLI | `@kilocode/cli` 7.8.8 | Linux x64 released binary; four skills, native server plugin, read, child-solution deleting preview, headless/sibling refusal and actual shell hook | CLI TUI native adapter; fresh person qualification pending; headless person-terminal route |
| Kilo VS Code | `kilocode.kilo-code` 7.8.8, Linux x64 VSIX; VS Code 1.139.1 | Actual isolated editor host and bundled backend; four skills, 64 native tools, read, child-solution deleting preview, headless/sibling refusal and actual shell hook | Person's own terminal; no native editor Cavelon dialog |

Both actual runtimes used a scripted loopback model endpoint and a fake local
instance. They sent no confirmation or guarded import, and made no real model,
database or production call. The editor was activated in its actual VS Code
host; a private inspection facade exposed its existing connection service
without replacing the client, backend, transport or tool logic.

Two setup regressions failed on 0.1.16. The implementation passed 233 focused
and neighboring checks, including Kilo configuration/managed-policy handling,
portable profiles, native lifecycle, bundled dialog protocol, shell guards and
documentation checks. Typecheck, lint and build passed. Simulated UI callbacks
are protocol evidence and do not count as a person's answer.

The private npm candidate loads without fetching an adapter dependency. Its
actual Kilo TUI displayed the packaged exact-change dialog; the fresh person's
Cancel/Confirm result and the complete offline workflow remain next-release
gates. No qualification is inherited from OpenCode. Other client versions,
macOS/Windows/WSL UIs, JetBrains and customer network/model pilots remain
separate. Installation and lifecycle: [Kilo](install/kilo.md).
