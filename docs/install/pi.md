# Pi

Current Pi has built-in MCP and a native extension system. Cavelon setup uses
the built-in configuration and native skill directories. It does not install a
replacement MCP extension. Native form approval is being qualified separately
in [#193](https://github.com/goodguys-gmbh/cavelon-dev-kit/issues/193).

These setup additions are under **Unreleased**. They are not in 0.1.15.

With Pi and Cavelon already installed, run in your own terminal:

```bash
cavelon setup --agents pi
```

Setup writes `~/.pi/agent/mcp.json` and `~/.pi/agent/skills/`, honoring
`PI_CODING_AGENT_DIR`. A solution's `cavelon init --agents pi` writes
`.pi/mcp.json` and `.pi/skills/`, alongside the existing shared skill copies.
It does not add other new clients' directories. The four authoritative skills
and their resources are the same in every destination.

Pi requires plain JSON for `mcp.json`; setup refuses comments, malformed files
and personal Cavelon entries rather than rewriting them. Other servers and
existing file permissions stay intact. The installed/offline entry is:

```json
{
  "mcpServers": {
    "cavelon": { "command": "cavelon", "args": ["mcp"] }
  }
}
```

Setup prefers the installed executable, otherwise the pinned npm release line
with platform-aware spawning. Init writes the npm fallback and keeps a
recognized installed or alternate-platform entry during updates. For an
offline project, use the entry above. Provision Pi, its model runtime and
Cavelon before blocking external egress. Coding-model and instance execution
providers are configured separately; setup does not install or select them.

Log in once in your own terminal with
`cavelon login --instance https://cavelon.example.com`; do not put the token in
Pi settings. Run `cavelon setup --check --agents pi`, then check `/mcp` in Pi
and load `/skill:cavelon-loop`. Pi reads project MCP only after **the person
grants project trust**; a project server replaces a user server with the same
name. Setup does not grant trust. Old `/mcp` replacement extensions can
override the built-in implementation: inspect your loaded extensions in Pi
and resolve that conflict yourself. File checks cannot certify arbitrary
extensions or a native approval dialog.

Pi's built-in MCP path lacks Cavelon's form approval. For every guarded change,
the agent shows the returned exact command and stops; the person runs it in
their own terminal outside the agent's control. Automatic tool permissions do
not replace this answer. A native extension must pass the fresh-person-dialog
checks before native approval is claimed. Database passwords and **Allow write
queries** remain person-only in the Admin.

Pi 1.1.0 exposes `PI_SESSION_ID` to its bash tool, which Cavelon recognizes.
If session-environment exposure is disabled, launch Pi with a process-scoped
`CAVELON_AGENT=1 pi` on POSIX, or set `$env:CAVELON_AGENT='1'` only in the
PowerShell terminal used to launch Pi. Never set the marker globally: the
person's separate terminal must remain usable. Environment detection prevents
mistakes; it is not an authorization boundary.

Update Cavelon and repeat `cavelon setup --agents pi`. In each existing solution
run `cavelon init --update`, then reload Pi. Remove user integration with
`cavelon setup --remove --agents pi`; personal MCP edits remain. Review project
files in the repository when removing project integration.

Qualification candidate: `@earendil-works/pi-coding-agent` 1.1.0. On Linux its
released skill loader found all four generated native skills, and its native
MCP runtime listed 64 tools and invoked `whoami` against a fake instance. The
bash tool's marker and native extension loader were also exercised without
model calls. Native dialog approval was simulated in protocol tests; an actual
person interaction and native Windows/WSL qualification remain outstanding.

Primary client references:
[MCP and trust](https://github.com/earendil-works/pi/blob/1cedd32724abfcb0915f76cc61b6827e2c16dbad/packages/coding-agent/docs/mcp.md),
[extensions](https://github.com/earendil-works/pi/blob/1cedd32724abfcb0915f76cc61b6827e2c16dbad/packages/coding-agent/docs/extensions.md).
