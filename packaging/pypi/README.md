# cavelon

The `cavelon` CLI and local MCP server for building Cavelon solutions with a
coding agent (Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI, Kiro).

This package carries the standalone `cavelon` executable for your platform, so
Python is only needed to install it:

```bash
uvx cavelon --version          # run it without installing
uv tool install cavelon        # or: pipx install cavelon, pip install cavelon
cavelon setup                  # set up your coding agents and log in
```

Wheels exist for Linux (x64, arm64, glibc 2.17 or newer), macOS 13 or newer
(Apple silicon, Intel) and Windows x64. The same release is on npm
(`npx -y @cavelon/cli`), Homebrew and as a one-line install script.

- Documentation and source: https://github.com/goodguys-gmbh/cavelon-dev-kit
- Installation: https://github.com/goodguys-gmbh/cavelon-dev-kit/blob/main/docs/installation.md
- Changelog: https://github.com/goodguys-gmbh/cavelon-dev-kit/blob/main/CHANGELOG.md

Licensed under Apache-2.0.
