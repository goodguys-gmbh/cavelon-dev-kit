# Check the connection before instance work

Loaded skills, a plugin marked installed, and a successful MCP handshake are
different from a working, authenticated instance connection. Before the first
instance operation for a selected solution folder in this session:

If this client intentionally uses CLI-only access, start with
`cavelon whoami --json` in the selected folder/target instead. Do not report
a missing MCP connection for a setup that does not use MCP. For native
Cavelon integrations, discover their `whoami` tool as you would an MCP tool.

1. For an MCP/native-tool integration, discover the Cavelon tools in the
   **actual coding-agent session**. Use the
   client's tool search where tools are deferred; not seeing an eagerly listed
   tool does not establish that the server is absent. Find `whoami`, rather
   than guessing a client-specific tool prefix.
2. Call that `whoami`, with the same `solution_dir` and tenant selection
   the task will use. On success, briefly tell the person that Cavelon is
   connected and authenticated and check the returned target and permissions.
   A successful call does not grant permissions its credential lacks.
3. If discovery or the call fails, **tell the person before proceeding**:

   | Observation | What to explain and how to recover |
   |---|---|
   | No usable Cavelon tools after discovery, or a transport failure | Cavelon's MCP connection is unavailable in this session. In Claude Code open `/mcp`, inspect the Cavelon server and reconnect it. Run `cavelon setup --check --agents claude` in a terminal for installation/start/login diagnostics; repair what it reports, then restart or reconnect the coding agent. Other clients use their own MCP/tools panel. |
   | `no_instance` | No instance is selected for this folder. Check its `cavelon.yaml`/environment; for a new setup, a person runs `cavelon login --instance <url>` in their own terminal. |
   | No token, expired/revoked token or an authentication refusal | Explain that Cavelon needs login again. A person runs `cavelon login --instance <url>` themselves. Never read, request or paste their token. |
   | Network, TLS, DNS or instance failure | Explain that the instance cannot be reached and pass on the error's safe repair hint. Do not describe it as a missing plugin or ask for another token without an authentication error. |
   | Permission or tenant refusal | The server is reachable, but this credential cannot perform that operation or enter that tenant. Follow the returned permission/target guidance. |

**Do not silently fall back.** A working CLI is a valid alternative, but say
"Cavelon MCP is unavailable; I am using the CLI instead" and check
`cavelon whoami --json` for the selected folder/target before using it. The
same permissions and confirmation rules apply. Offline authoring and
formatting may continue; do not claim instance validation, a test run, an
import or a deployment without a successful result from that operation.

Report a warning once while its cause stays the same. Check again after a
reconnect, login, selected-target change or subsequent connection failure,
and announce recovery once. Do not probe the connection before every tool.

Claude Code's plugin startup hook shows a notice in a Cavelon workspace,
including repositories with child solutions. It checks only whether `cavelon`
or `npx` is on PATH, without executing either, fetching packages, reading
credentials or contacting the instance. Its notice says the connection is
**not yet verified**, not failed. SessionStart runs before MCP is available;
the in-session check above supplies the actual evidence. A new-solution
request in an unrelated folder gets this check when the skill is first used.
