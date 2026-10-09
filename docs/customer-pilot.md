# Customer pilot

A customer pilot checks the dev-kit in one customer's real setting: their
hosts and operating systems, their coding client, their model and network
decisions, their databases and a test tenant on their instance. It answers the
questions the kit's own tests cannot: the kit is tested against snapshots of
what an instance publishes, a fake local instance and scripted model responses
([qualification matrix](coding-agent-qualification.md)), and no release
records a customer's pilot.

This page is the checklist and the report template. Copy the template, fill it
in as you go, and keep it with the customer's records.

## Ground rules

- **A test tenant, never production.** Every step runs against a tenant made
  for the pilot. Nothing in the pilot activates a solution that real users
  reach.
- **Credentials stay with people.** A person creates the personal access
  token, logs in from their own terminal and keeps the token in their
  credential store. A person sets database passwords in the Admin. No token,
  password, API key or connection string with a secret goes into the report,
  a chat, a ticket, a screenshot, a repository or a coding agent's prompt. The
  report names who held a credential (by role) and what it may do, never its
  value.
- **Model decisions are the customer's, and there are two of them.**
  - The **coding model**: the endpoint the coding client (Claude Code, Codex,
    OpenCode, …) uses to write the solution. It is configured in that client,
    outside the kit.
  - The **instance's models**: the tenant's Model Registry, which the
    customer's instance governance decides. Within what the tenant offers,
    the kit authors a solution's model bindings (an agent's `llm_model` and
    `llm_provider`, from `cavelon models list`). `cavelon models set-limit`
    changes a self-hosted endpoint's `max_concurrent_requests` only with a
    person's yes. A `model_registry` import (`apply --include-tenant-wide`)
    changes every solution of the tenant, so a pilot leaves it to that
    governance.

  The report records each decision and who made it, never a key.
- **Only a person's answer is a person's approval.** A scripted or simulated
  answer proves the protocol, not the person's experience. Label every result
  as **automated**, **simulated** or **actual person**.
- **One combination at a time.** A result holds for the platform, client and
  version it ran on. Native Windows, WSL, macOS and Linux are separate
  platforms; a CLI is not its editor extension; a related client inherits
  nothing.
- **Say "the instance".** The report names no internal host name, address,
  repository or person outside the pilot team; use roles and "the instance".

## Before the pilot

| Decide | Who decides | Record |
|---|---|---|
| Platforms and clients to cover, with exact versions | customer and pilot lead | the scope table |
| Install route: one-line install, Homebrew, PyPI, npm, or the [offline bundle](offline-bundle.md) | customer IT | route and kit version |
| Network posture: open, through a proxy, or no internet access | customer security | which hosts the machines reach |
| Coding model endpoint | customer | provider class (hosted, internal, self-hosted) and approval |
| Models the tenant offers to solutions | customer's instance governance | provider class and approval |
| Databases and dialects to connect, and their read-only accounts | customer DBA | dialect and version, never credentials |
| Who holds the token with **May activate**, if anyone | customer | role |

Provision the coding client and its model before the pilot; the kit does not
install either. For machines without internet access, bring in the verified
bundle first ([Verify the bundle](offline-bundle.md#verify-the-bundle)).

## Checklist

### Install and setup

- [ ] `cavelon` installed by the chosen route; `cavelon --version` shows the
      expected version and install method.
- [ ] Offline only: the bundle's signature verified against the release
      workflow's identity for its tag, and its files against the manifest,
      before anything was extracted.
- [ ] `cavelon setup --agents <client>` set up the client;
      `cavelon setup --check` reports it working.
- [ ] A person logged in from their own terminal; `cavelon whoami` names the
      pilot tenant.
- [ ] The coding agent lists the four Cavelon skills and the Cavelon tools,
      and its transcript holds no token.

### Development loop, in the pilot tenant

- [ ] The agent created or pulled a solution, ran `validate`, previewed and
      imported a draft, uploaded knowledge, ran a test suite, waited for it and
      read a trace.
- [ ] One change to a prompt or test, then the loop again.
- [ ] Every command needed for the loop finished within its bounded wait, or
      `cavelon wait` resumed it.

### Person approval

- [ ] A guarded change (for example an import that deletes a draft agent in the
      pilot tenant) asked the person, in the client's dialog or in their own
      terminal, before anything changed.
- [ ] The person's No (or Cancel) changed nothing.
- [ ] A fresh preview and the person's Yes applied exactly that change, once.
- [ ] A second guarded change asked again; the earlier Yes did not carry over.
- [ ] Where the client has no person dialog (headless, print or RPC mode), the
      change was refused or handed to the person's terminal.

### Network and offline

- [ ] With the customer's egress rules in force, setup, the MCP server and the
      loop worked without reaching npm, PyPI or GitHub. Offline setup writes
      `cavelon mcp`, never `npx`, once each selected plugin client (Claude
      Code, Codex, Gemini CLI) has its plugin installed from the bundle, or
      when `--agents` names only clients set up through files; otherwise
      setup fetches the missing plugin or extension from GitHub.
- [ ] A proxy, if used, worked as [Behind a proxy](installation.md#behind-a-proxy)
      describes.
- [ ] The daily update lookup stayed quiet, or was turned off with
      `CAVELON_NO_UPDATE_CHECK=1`.

### Databases

Run these against a test database or a read-only account approved for the
pilot. [Connect a database](connect-a-database.md) has each step.

- [ ] `cavelon db instance` lists the dialect the pilot needs, the firewall
      addresses and the tenant's limits.
- [ ] The DBA created the login from `cavelon db login-script <dialect>`,
      replacing its password placeholder locally, outside the kit.
- [ ] A person set the connection's password in the Admin.
- [ ] `cavelon db test <connection>` passed each step.
- [ ] A saved query ran with `cavelon db test-run`, including a list
      parameter given as a JSON array where the instance publishes them.
- [ ] Oracle only, where the instance publishes it: the connection names a
      listener that serves the session itself. The instance refuses listener
      redirects (RAC SCAN, shared-server dispatchers on another host or port)
      by design.
- [ ] Write queries, if any, stayed off unless a person turned on **Allow
      write queries** in the Admin.

### Models

- [ ] The coding client used the approved coding model; it called the Cavelon
      tools and followed the skills. Record what was observed, not a quality
      rating.
- [ ] The solution's agents name models the tenant offers
      (`cavelon models list`), and the test suite ran on them; record its
      results and anything the traces show about the models.

## Report template

Copy this into the customer's records and fill it in. Leave a line empty
rather than guess.

```markdown
# Cavelon dev-kit pilot report

- Pilot dates:
- Pilot lead (role):
- Kit version and install route:
- Instance: the instance (its version from `cavelon status`):
- Tenant: a pilot tenant (no production data)

## Scope

| Platform (native Windows / WSL / macOS / Linux, arch) | Client and version | Surface (CLI, editor, desktop) |
|---|---|---|
|  |  |  |

## Decisions

| Decision | Choice (class, not secret) | Decided by (role) |
|---|---|---|
| Coding model endpoint |  |  |
| Models the tenant offers to solutions |  |  |
| Network posture |  |  |
| Databases and dialects |  |  |
| Token holders and permissions |  |  |

## Results

| Check | Platform and client | Result (pass / fail / not run) | Evidence kind (automated / simulated / actual person) | Evidence kept where |
|---|---|---|---|---|
| Install and setup |  |  |  |  |
| Development loop |  |  |  |  |
| Person approval: No changes nothing |  |  |  |  |
| Person approval: fresh Yes applies exactly one change |  |  |  |  |
| Person approval: no reuse of an earlier Yes |  |  |  |  |
| Network and offline |  |  |  |  |
| Database connection and query |  |  |  |  |
| Models |  |  |  |  |

## Not covered

Platforms, clients, surfaces and checks this pilot did not run:

## Problems found

Command, `cavelon --version`, exit code, error code and what was expected.
No tokens, passwords, customer data or internal host names.
```

## After the pilot

A passed pilot qualifies only the combination it ran on, for that customer. A
problem with the kit goes to
[GitHub issues](https://github.com/goodguys-gmbh/cavelon-dev-kit/issues) as
[Troubleshooting](troubleshooting.md#still-stuck) says, without customer
names or data; a security problem goes through [SECURITY.md](../SECURITY.md).
