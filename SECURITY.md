# Security policy

## Reporting a vulnerability

Please report a vulnerability privately, through GitHub's private vulnerability
reporting: on this repository's **Security** tab, choose **Report a
vulnerability**
([direct link](https://github.com/goodguys-gmbh/cavelon-dev-kit/security/advisories/new)).
Do not open a public issue, pull request or discussion for it.

Tell us what is affected (the `cavelon` CLI, its MCP server, the plugin or its
skills), the version (`cavelon --version`), how to reproduce it and what an
attacker gains. Leave out real tokens, secrets and customer data; a redacted
excerpt is enough.

We acknowledge the report, keep you informed in the advisory while we fix it,
and publish the advisory with the release that fixes it.

## Supported versions

Only the latest release receives security fixes. Update with the steps in the
[installation guide](docs/installation.md#updating).

## Scope

The kit runs on a developer's machine with that developer's own token. Of
particular interest:

- a token or secret value reaching a log, the terminal, a file in the
  repository or the coding agent;
- a `cavelon.yaml`, package file or MCP request that makes `cavelon` send a
  token to another instance than the one it was stored for;
- a file written outside the solution folder, or a customer's file overwritten
  outside the kit's marked blocks.
