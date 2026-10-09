# Coding-agent qualification

Setup support and real-client qualification are recorded separately. Version
0.1.16 added OpenCode, Pi and Qwen Code CLI. The 0.1.17 candidate adds Cline,
Kilo, Goose and OMP. Fresh Cline person-terminal and OMP native No/Yes checks
passed on the packaged Linux candidate. Existing clients keep their installation
routes.

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

The opt-in released-client CI lane runs all seven pinned CLIs: OpenCode 1.18.35,
Pi 1.1.0, Qwen Code CLI 0.25.0, Cline CLI 3.0.70, Kilo CLI 7.8.8, Goose CLI 1.53.0
and OMP CLI 18.8.5 on native Linux x64, macOS arm64 and Windows x64. Each actual
client consumes generated setup and the platform's locally built standalone
Cavelon executable. It completes two ordinary draft workflows against scripted
loopback fixtures: child validation, preview/import, synthetic suite, wait and
trace, with one bounded prompt improvement between runs. These checks send no
guarded confirmation and open no person dialog. Qwen uses its actual deferred
`tool_search`/`tool_call` dispatch; no host registry is replaced. This automated
evidence does not qualify human UI, editor, desktop, ACP/RPC or WSL surfaces.
See [running the runtime checks](../CONTRIBUTING.md#released-coding-client-runtimes).

Client checks use a fake local instance and synthetic data, with no real model
provider calls or database execution. The 0.1.17 Linux candidate also passed npm
consumer and locally installed offline-bundle workflows for Cline, Kilo, Goose
and OMP. Each validated a child solution, previewed and imported an ordinary
draft, ran and waited for a synthetic suite, read its trace, then repeated after
one bounded prompt improvement: two imports, suites and traces, with no guarded
changes or instance confirmation ids. Coding clients and fixture providers
were provisioned separately; this does not certify a customer's model or network.

Programmatic fixture calls prove transport
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

The maintained [supervisor fixture](person-approval-qualification.md) prepares
portable loopback deleting-import/query-limit checks for another host. Its
automated evidence is labeled simulated; the own-terminal and Pi/OMP native
routes require actual person interaction and separate operator attestation.
It adds tooling, not Windows, WSL, macOS or editor acceptance.

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

## 0.1.17 candidate: Cline integration

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
[Cline](install/cline.md). The 0.1.17 candidate passed complete npm and locally
installed Linux offline workflows, each with two ordinary draft imports,
synthetic suites and traces around one bounded prompt improvement.

The packaged own-terminal check passed with generated Cline setup in a
multi-solution root. The agent and sibling-preview paths refused without a
confirmation or import. The person's fresh terminal command sent one
confirmation bound to exactly one synthetic child import, deleting an obsolete
agent and changing a fake query limit from 5 to 10. It made no real model,
database or production call. No native Cavelon dialog is claimed for Cline.
Other platforms, editor variants and customer model/network pilots remain
separate work.

## 0.1.17 candidate: Kilo integration

| Surface | Pinned version | Runtime checked | Guarded-change mode |
|---|---|---|---|
| Kilo CLI | `@kilocode/cli` 7.8.8 | Linux x64 released binary; four skills, native server plugin, read, child-solution deleting preview, headless/sibling refusal and actual shell hook | CLI TUI native adapter; packaged fresh Cancel/Confirm passed; headless person-terminal route |
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
actual Kilo 7.8.8 TUI passed the person's fresh Cancel/Confirm check. Cancel
sent no confirmation or mutation. A fresh Confirm applied one exactly bound
synthetic child-solution import, deleting an obsolete agent and changing a fake
query's row limit from 5 to 10. A sibling's preview was refused in both cases.
This person check made no model call and used no real database or instance.
The 0.1.17 candidate passed complete npm and locally installed Linux offline workflows, each with two draft imports, synthetic suites and traces around one bounded prompt improvement. No qualification is inherited from OpenCode. Other client versions,
macOS/Windows/WSL UIs, JetBrains and customer network/model pilots remain
separate. Installation and lifecycle: [Kilo](install/kilo.md).

## 0.1.17 candidate: Goose integration

| Surface | Pinned version | Runtime checked | Guarded-change mode |
|---|---|---|---|
| Goose CLI | 1.53.0 | Linux x64 released binary; four native skills, 64 MCP tools, read, child-solution deleting preview, sibling refusal and actual session shell guard | Built-in interactive MCP form; headless elicitation refuses; packaged fresh No/Yes passed |
| Goose Desktop / ACP hosts | Separate surfaces | User configuration is described; actual host dialog qualification remains separate | Never infer a person dialog from CLI or file checks |

Two setup regressions failed on the base. Focused configuration, YAML
preservation, lifecycle, project-skill and shell tests pass. The actual released
CLI used only scripted loopback responses and a fake instance. Headless
confirmation cancelled with no instance confirmation or mutation. It set a
session marker even without an inherited Cavelon marker. No real model,
database or production call was made. A private offline npm consumer then passed
the actual person's fresh No/Yes check in Goose's built-in form: No issued no
confirmation or mutation; a new preview and Yes issued one exactly bound
confirmation and import. It deleted one synthetic agent and changed a fake
query's row limit from 5 to 10, with sibling previews still refused.

Goose's form expires after five minutes; a late answer can report `Request not
found` without approving the change. The 0.1.17 candidate passed the complete npm and locally installed Linux offline workflows, each with two ordinary draft imports, synthetic suites and traces around one bounded prompt improvement. No custom native adapter is needed for the CLI's
built-in form. See [Goose](install/goose.md).

## 0.1.17 candidate: OMP integration

| Surface | Pinned version | Runtime checked | Guarded-change mode |
|---|---|---|---|
| OMP CLI | 18.8.5, Bun 1.3.14 | Linux x64 released npm CLI; four native skills, 64 essential Cavelon tools, read, deleting child preview, sibling refusal and actual guarded shell | Separate bundled native TUI extension; print-mode refusal and packaged fresh No/Yes passed |
| OMP RPC / ACP and other platforms | Separate surfaces | Configuration and lifecycle file checks do not qualify these runtimes | Missing UI uses the person's terminal; host dialogs require separate evidence |

The setup regression failed on the base. Native configuration and profile
selection, personal settings, ownership lifecycle and neighboring tests pass.
The actual released CLI loaded the generated autoload extension and used only
scripted loopback responses and a fake instance. Its model-facing catalog had
all 64 Cavelon tools and its instructions named all four skills. Read, validation,
child-solution deleting preview, sibling-preview refusal and actual shell guards
passed. Print-mode confirmation made no instance confirmation or mutation.
Native errors propagate as error results. No real model, database or production
call was used. The actual packaged OMP TUI loaded 64 tools and passed a
read/validate readiness check. The 0.1.17 candidate passed complete npm and
locally installed Linux offline workflows, each with two ordinary draft imports,
synthetic suites and traces around one bounded prompt improvement.

The actual person's fresh No/Yes TUI check passed on the packaged Linux
candidate. No sent no confirmation or mutation; a fresh Yes issued one
confirmation bound to exactly one synthetic import, deleting an obsolete agent
and changing a fake query limit from 5 to 10. Sibling previews refused in both
cases. No script supplied the person's answers. See [OMP](install/omp.md).
