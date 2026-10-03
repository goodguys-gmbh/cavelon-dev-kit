# Working in this repository (for coding agents)

This repository holds the `cavelon` CLI and MCP server (`cli/`), the Cavelon
plugin for Claude Code and Codex (`plugin/`), an example solution
(`examples/support-faq/`) and the contract snapshots the tests run against
(`contracts/`). [CONTRIBUTING.md](CONTRIBUTING.md) is the full guide; this is
the short version.

## Build, test, lint

```bash
cd cli
npm ci --ignore-scripts
npm run typecheck && npm run lint && npm test
npm run build && node dist/cli.js --help
```

Tests never need a real instance: a fake server in `cli/test/` serves the
snapshots in `contracts/cavelon/`. After changing a command's options or help
text, regenerate the command reference with `npm run docs:commands`; a test
fails while `docs/commands.md` is out of date.

## Conventions

- **Published contracts only.** The kit learns an instance from what it
  publishes: its OpenAPI, `/api/v1/meta/capabilities`,
  `/api/v1/meta/error-catalog`, the package schema and the docs. Never
  hard-code what those can tell you. A new operation goes into
  `contracts/kit-operations.json`; `contracts/README.md` says how to refresh
  the snapshots.
- **Built for agents.** Every command works without a prompt, offers `--json`,
  uses the documented exit codes, bounds its waits and its output, and is
  marked read-only or changing.
- **Older instances.** Read every field a recent instance added with a
  fallback for one that does not publish it, and test both in the fake server.
- **Secrets stay with people.** Never accept a token or secret value as a
  command-line argument, never log one, never write one to a repository.
- **Never overwrite a customer's file** the kit did not create; change only the
  blocks between the kit's markers.
- **Regular expressions:** no quantified group anchored at the end (such as
  `/(\r?\n)+$/`); trim with a loop instead. Build file paths only from
  validated names.
- **English** in code, comments, docs, commits and pull requests. Comments say
  why, not what.
