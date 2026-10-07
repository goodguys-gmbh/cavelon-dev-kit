# Gemini CLI

Gemini CLI installs the Cavelon [extension](https://geminicli.com/docs/extensions/reference/)
from this repository's releases: the four skills (Gemini CLI loads each when
it is needed) and the `cavelon` MCP server, as one unit it updates and removes.
Other clients: [Install the kit in your coding agent](README.md).

Google is moving Gemini CLI's users to the Antigravity CLI, which serves
individual Google accounts in place of Gemini CLI; Gemini CLI keeps working
with a Gemini API key or a Code Assist Standard or Enterprise licence. The
Antigravity CLI converts installed extensions with `agy plugin import gemini`.

## Install

`cavelon setup` does it for you, then logs you in. By hand:

```bash
gemini extensions install https://github.com/goodguys-gmbh/cavelon-dev-kit --consent
```

Gemini CLI downloads the newest release's extension for your system
(`<platform>.cavelon-gemini-extension.tar.gz`). `--ref vX.Y.Z` installs that
release's instead (`cavelon setup` installs the one of the `cavelon` it runs
as), and `--auto-update` keeps it current. Leave out `--consent` to read what
Gemini CLI asks you to agree to first. Run it outside a project you do not
trust: Gemini CLI marks the folder it installs from as trusted.

**From a download**, for a machine that cannot reach GitHub: unpack the
extension of your system ([The packages](README.md#the-packages)) into a folder
and install that. Gemini CLI asks whether you trust the folder:

```bash
mkdir cavelon-extension && tar -xzf linux.cavelon-gemini-extension.tar.gz -C cavelon-extension
gemini extensions install ./cavelon-extension
```

The extension appears with the first release after 0.1.11. Until then, or when
the install fails, `cavelon setup` puts the skills into `~/.gemini/skills/` and
the server into `~/.gemini/settings.json` instead, and the next `cavelon setup`
after an update replaces them with the extension.

Gemini CLI passes MCP servers only a few safe environment variables, so
`CAVELON_TOKEN` and `CAVELON_URL` from your shell do not reach the server: log
in with `cavelon login`.

## Log in

Once, in a terminal of your own: `cavelon login --instance https://cavelon.example.com`
([The first login](README.md#the-first-login)).

## Check

```bash
gemini extensions list    # ✓ cavelon (X.Y.Z), MCP servers: cavelon, Agent skills: cavelon-…
gemini mcp list           # ✓ cavelon (from cavelon): sh -c if command -v cavelon … (stdio) - Connected
gemini skills list        # cavelon-authoring, cavelon-long-running, cavelon-loop, cavelon-testing [Enabled]
cavelon setup --check --agents gemini
```

In a session, `/extensions list`, `/mcp list` and `/skills list` show the same.

## Update

```bash
gemini extensions update cavelon
```

An extension installed from a download: install the new release's file the same
way. When the extension is behind, the MCP server says so in the session.

## Remove

```bash
gemini extensions uninstall cavelon
```

`cavelon setup --remove` does it when `setup` installed it.

## What was verified

Gemini CLI 0.63.0, without signing in, validated each platform's extension,
installed the Linux one from a folder, listed its four skills and its MCP
server, and connected to the server (`gemini mcp list`: Connected); CI repeats
this on every change. Installing from a GitHub release was tried with another
extension whose assets follow the same naming; this repository's first release
with the extension is the first that can be installed that way.
