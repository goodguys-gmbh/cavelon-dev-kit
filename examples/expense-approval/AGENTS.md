<!-- cavelon:begin -->
## Cavelon solution

This folder is a Cavelon solution (`cavelon.yaml`): edit `package/`, `tests/` and `env/`, then run `cavelon validate` and `cavelon apply`.
Use the Cavelon skills (cavelon-loop, cavelon-authoring, cavelon-testing, cavelon-long-running); without them, `cavelon --help` and `cavelon docs search <query>` lead on.
`cavelon apply` only previews; show a preview that reaches an active solution or `env/prod` to a person before `cavelon apply --confirm <id>`.
`cavelon status` shows the instance, tenant and open previews, and `.cavelon/inventory.md` the tenant's solutions, knowledge bases and tools. A person runs `cavelon login`; never handle a token.
<!-- cavelon:end -->
