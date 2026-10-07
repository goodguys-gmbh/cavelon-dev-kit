# Cloud agents and CI

An agent that runs without you (a cloud agent in its own environment, or a CI
job) installs nothing for a person and has no terminal for `cavelon login`. It
runs `cavelon` through `npx` or `uvx`, gets the skills and the MCP entry from
the repository, and the token from its secret store. Other clients:
[Install the kit in your coding agent](README.md).

## Install

**`cavelon` itself**, without installing it:

| With | Run | Needs |
|---|---|---|
| npx | `npx -y @cavelon/cli@0.1 <command>` | Node.js 20.3 or newer |
| uvx | `uvx 'cavelon>=0.1,<0.2' <command>` | uv |

Both take the newest 0.1 release, so a release that may change behaviour (0.2)
waits until you move the range. Name an exact version to stay on one:
`@cavelon/cli@0.1.12` for npx, `cavelon@0.1.12` for uvx (where `cavelon@0.1`
would mean exactly 0.1.0). The PyPI wheels, which `uvx` runs, are published
from the first release after 0.1.11 on.

**The skills and the MCP server** for a cloud agent come from the repository it
works on: commit what `cavelon init --agents` writes into the solution folder
([Agents without a plugin](../installation.md#agents-without-a-plugin)):

```bash
cavelon init --agents claude,codex,copilot,cursor
```

It writes the skills to `.agents/skills/` and `.claude/skills/`, an MCP entry
per agent that starts `npx -y @cavelon/cli@0.1 mcp`, and a Cavelon block in
`AGENTS.md`, so Claude Code on the web, Codex cloud, GitHub's Copilot coding
agent or Cursor's background agents find them when they open the repository.
Where the environment has uv instead of Node.js, change the entry to
`{ "command": "uvx", "args": ["cavelon>=0.1,<0.2", "mcp"] }`; `cavelon init --update`
keeps an entry you changed.

## Log in

Give the job a token of its own from the system's secret store, in the
environment:

```bash
export CAVELON_URL=https://cavelon.example.com
export CAVELON_TOKEN=…   # from the secret store, never in the repository
```

or piped into `cavelon login --instance <url> --token-stdin`. `CAVELON_TOKEN` is
sent only to the instance `CAVELON_URL` names. Use a token without
**May activate**, so the job can preview and test but a person confirms
production, and so you can revoke it alone ([Security](../security.md#your-token)).
Where the environment has no credential store, `login` keeps the token in a
file only the user can read.

A GitHub Actions job, for example:

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: 22
- name: Validate and test the solution
  env:
    CAVELON_URL: ${{ vars.CAVELON_URL }}
    CAVELON_TOKEN: ${{ secrets.CAVELON_TOKEN }}
  run: |
    npx -y @cavelon/cli@0.1 validate
    npx -y @cavelon/cli@0.1 test run --wait --timeout 10m --json
```

## Check

```bash
npx -y @cavelon/cli@0.1 --version        # the version, and "installed with: npx"
npx -y @cavelon/cli@0.1 whoami --json    # as whom, in which tenant
uvx 'cavelon>=0.1,<0.2' whoami --json
```

`whoami` exits 7 without a token and 2 without an instance
([Exit codes](../troubleshooting.md#exit-codes)). A cloud agent lists the
skills and the `cavelon` MCP tools as its own client does (the client's page,
from [Install the kit in your coding agent](README.md)).

## Update

On a fresh runner, `npx` and `uvx` take the newest release of the range each
time. Where uv's cache stays between runs, `uvx` reuses the release it cached:
add `--refresh` to look again. Move the range (`0.1` to `0.2`) when you choose
to, and run `cavelon init --update` in the solution folder to refresh the
committed skills.

## Remove

Remove the job's steps and the committed skill files and MCP entries (the files
`cavelon init` marked as generated, and the block between `cavelon:begin` and
`cavelon:end` in `AGENTS.md`), and revoke the token on `/account/access-tokens`.
