# The Dev-Kit

> Installing the Cavelon dev-kit, also from this instance without GitHub, logging in with a personal access token, how it picks a tenant, and where to copy a tenant's or a solution's ID and slug

The Cavelon dev-kit lets a developer build, test and ship solutions from a git repository, with a coding agent such as Claude Code or Codex, instead of clicking through the Admin. It has two parts: `cavelon`, a command-line tool and local MCP server, and a plugin that teaches the coding agent the development loop. The kit's [README](https://github.com/goodguys-gmbh/cavelon-dev-kit#readme) describes it in full; this page covers what happens on this instance.

## Installing cavelon

One line installs `cavelon` as a standalone program, without Node.js:

```bash
# macOS and Linux
curl -fsSL https://github.com/goodguys-gmbh/cavelon-dev-kit/releases/latest/download/install.sh | sh
```

```powershell
# Windows, in PowerShell
irm https://github.com/goodguys-gmbh/cavelon-dev-kit/releases/latest/download/install.ps1 | iex
```

With Node.js 20.3 or newer you can skip the install: put `npx -y @cavelon/cli` in place of `cavelon` in every command on this page, for example `npx -y @cavelon/cli whoami`.

## Installing from this instance

An instance can serve the dev-kit itself, at `/dev-kit/` on its own address, for machines that reach neither GitHub nor npm. Whether yours does is up to its operator. When it does:

- the **Personal access tokens** page shows **Install the dev-kit from this instance**, and the **Use with the dev-kit** panels install from the instance instead of GitHub;
- `https://cavelon.example.com/dev-kit/` (with your instance's address) lists the releases it serves. The one marked latest is the newest that fits this instance's version.

The installer takes `cavelon` from the instance when `CAVELON_DOWNLOAD_URL` names the release's `bin` folder, and checks it against `checksums.txt` from the same folder, as it does from GitHub:

```bash
# macOS and Linux
curl -fsSL https://cavelon.example.com/dev-kit/latest/bin/install.sh | CAVELON_DOWNLOAD_URL=https://cavelon.example.com/dev-kit/latest/bin sh
```

```powershell
# Windows, in PowerShell
$env:CAVELON_DOWNLOAD_URL = 'https://cavelon.example.com/dev-kit/latest/bin'; irm https://cavelon.example.com/dev-kit/latest/bin/install.ps1 | iex
```

Each release there is also the kit's signed offline bundle, `cavelon-bundle-<version>.tar.gz`, beside its Sigstore signature. It carries the plugin for Claude Code and Codex, the skills for other agents, and an MCP entry that starts the installed `cavelon` instead of `npx`. Without GitHub, install the plugin from it, then let `setup` find it:

```bash
curl -fsSLO https://cavelon.example.com/dev-kit/0.1.13/cavelon-bundle-0.1.13.tar.gz
tar -xzf cavelon-bundle-0.1.13.tar.gz
claude plugin marketplace add "$PWD/cavelon-bundle-0.1.13"
claude plugin install cavelon@cavelon-dev-kit
cavelon setup --instance https://cavelon.example.com
```

Keep the unpacked folder: the coding agent reads the marketplace from there. The kit's [offline bundle guide](https://github.com/goodguys-gmbh/cavelon-dev-kit/blob/main/docs/offline-bundle.md) explains verifying the signature yourself and installing in Codex and the other agents. The instance checked the signature, and every file against the bundle's manifest, before it served them.

## Logging in

The kit signs in with a [personal access token](/docs/administration/personal-access-tokens), never with your password:

1. Open the user menu, choose **Personal access tokens**, then **Create token**. **Builder** is preselected, the least that covers building and testing a solution; [Which ceiling?](/docs/administration/personal-access-tokens#which-ceiling) explains the others. Tick **May activate** only if this token may put solutions live.
2. After **Create token**, the dialog shows the token once and, under **Use with the dev-kit**, the commands for this instance, each with a copy button: the installer lines above, then

   ```bash
   cavelon setup --instance https://cavelon.example.com
   cavelon login --instance https://cavelon.example.com
   cavelon whoami
   ```

   and the first of them with `npx -y @cavelon/cli` in place of `cavelon`, for people who have Node.js and don't want to install anything.

3. Run them in your own terminal, not in the coding agent's chat. `setup` finds your coding agents (Claude Code, Codex, Cursor, VS Code with GitHub Copilot, Gemini CLI, Kiro), shows what it will change, sets them up for Cavelon and logs you in. `login` alone only logs in, and `whoami` checks the login. Both ask for the token; paste it there. The kit keeps it in your system's credential store, and your coding agent never sees it.

The dialog fills in this instance's address. For a token limited to one tenant, the `login` line adds `--tenant` with that tenant's slug, and for a platform operator's token the slug of the tenant you have open.

## Bringing a solution into a repository

On the **Solutions** page, the selected solution's card has **Use with the dev-kit**. It shows the installer lines, then the commands for this instance, the tenant and that solution, each with a copy button, and the `npx` alternative:

```bash
cavelon setup --instance https://cavelon.example.com
cavelon login --instance https://cavelon.example.com
cavelon init --instance https://cavelon.example.com --tenant alpen-desk --harness expense-approval
cavelon pull
```

`setup` or `login` is needed once per instance. Run `init` and `pull` in an empty folder: `init` records the instance, tenant and solution in `cavelon.yaml`, and `pull` writes the solution's package into the folder. The tenant goes by its slug, which the kit resolves for every kind of token; the panel shows the tenant's ID beside it, to copy for an older kit.

## Changes you confirm

A change that reaches live traffic or the whole tenant waits for your yes, also when your coding agent runs the kit: making a solution the default route, activating one that a channel or trigger reaches, deactivating one, an import with `--include-tenant-wide`, deleting a variable, binding or changing a trigger's execution identity, and creating, changing or deleting a database query, an import that creates or changes one included. The kit shows you what would change and asks you, in your coding agent's dialog or in your own terminal; the kit does not let your agent answer for you. The instance binds the confirmation as well: such a change from a personal access token carries a confirmation that names exactly this change and lasts 10 minutes. The instance does not see your answer, so the kit is what asks you ([how it works](/docs/reference/api-endpoints#changes-a-person-confirms)). If a change is refused with `confirmation_required`, update the kit, or make the change yourself in the Admin. Working on a draft that nothing reaches needs no confirmation.

## Choosing an agent's model

An agent's `llm_model` must be an active model in the target tenant's model registry. A package written elsewhere, an example package included, can name a model this instance's tenants don't have, and its import preview then blocks with `model_not_in_registry`. `cavelon models list` shows the models the tenant has; put one of those in `llm_model`, or add the model under **Settings › Models** ([Model Registry](/docs/administration/model-registry#registered-models)).

`temperature` is optional. A reasoning model on OpenAI, Azure or Anthropic receives no temperature at all. Set the reasoning level instead: `model_settings_extra.reasoning_effort`, `low`, `medium` or `high` (or another level the model's registry entry declares). It is the agent's **Reasoning effort** in the editor. The package schema describes `reasoning_effort` under `model_settings_extra`, which also passes a provider's own settings through.

## How the kit picks the tenant

A personal access token can reach several tenants, and the kit picks the one to work in by itself where it can:

- A token limited to one tenant (**Tenants** on the token form) acts there. No `--tenant` is needed, though the dialog names it anyway.
- A token that reaches several tenants: `setup` and `login` list them, and you choose by number or name. Without a terminal, `login` stores the token and prints one `cavelon use <tenant>` line per tenant; in CI set `CAVELON_TENANT`.
- A platform operator's token works in any tenant you name, one at a time, and in none you don't: without a tenant it is in Platform mode, which it may enter only with **Allow Platform mode**. `setup` and `login` ask for part of the tenant's name.
- `--tenant` and `cavelon use` take a tenant's name, slug or ID. Switch the tenant later with `cavelon use`.

A tenant API key (`cbp_…`) belongs to one tenant and never needs a tenant.

## Where IDs and slugs are

The kit and the API name a tenant by its ID or slug and a solution by its slug or ID. Each is shown with a copy button:

| What | Where |
|---|---|
| The open tenant's ID and slug | The tenant switcher in the header: open it, and the bottom of the menu shows both |
| The tenant's ID and slug | **Settings**, under the page title |
| The tenants of a token, each with its slug (or its ID where the slug is not known yet) | **Personal access tokens**, in the token's row |
| Any tenant's ID and slug (operators) | **Platform › Tenants**: in each row, without opening it, and in the tenant's detail panel |
| A solution's slug and ID | **Solutions**: on the selected solution's card, in each row of **All solutions**, and the slug in the solution's **Edit** panel |

A solution's slug is what `cavelon pull --harness <slug>` takes; it also appears in the address bar as `/solutions/<slug>/…`.
