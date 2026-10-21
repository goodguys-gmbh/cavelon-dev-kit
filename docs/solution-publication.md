# Reviewing and publishing solution drafts

These commands apply when the instance advertises its solution-publication
API. Older instances report `operation_unavailable`; their existing editing
behavior is unchanged. Publication commands are available from kit 0.2.8.
The warnings/check results and publication-specific approval form described
below are available from kit 0.2.9.

An active solution can have a **published version** serving live traffic and
an **unpublished draft** for graph edits. `apply` shows the instance's
`publication` report: `target: draft` means those scoped edits await publication.
A routine scoped apply can use the existing YOLO path when this report names
the matching solution and both version numbers, with known effects and no
shared/query/production/destructive reason for person review. Incomplete or
older metadata keeps the existing confirmation. Publish remains separate.
Tools, knowledge bases, secrets and other tenant-wide resources keep their
existing shared behavior; a graph draft does not isolate changes to them.

1. Edit, validate and apply the solution package using the usual preview.
2. Inspect the pending version and readiness:

   ```bash
   cavelon harness publication <solution> --json
   ```

3. Run the solution's tests and fix the instance's Graph Check/readiness
   blockers. Review the unpublished changes, remaining warnings, readiness
   check results and affected waiting runs:

   ```bash
   cavelon publish --harness <solution>
   ```

4. Follow the preview's confirmation instruction. In a person's own terminal:

   ```bash
   cavelon publish --harness <solution> --confirm
   ```

Publishing changes live traffic. In an agent, the MCP client asks the person
with the preview's token, or the person runs the printed command in their own
terminal. YOLO does not skip this confirmation. The kit offers no force option;
readiness blockers must be fixed. The instance rechecks readiness and the
reviewed version, draft revision and waiting-run set before applying anything.
A conflict needs a new review and a fresh confirmation.

### Publish from your coding agent

Ask the agent to check the solution and prepare publication. It first shows
the pending edits, blocking findings, remaining warnings and readiness checks.
The review includes the instance's test findings; publication does not start
a new test run. Blockers must be fixed before a publish form is offered.

Once the review is ready, a client that supports MCP forms presents one form
with the solution, target instance and tenant, published version and draft
revision, remaining warnings, affected waiting runs and the consequences for
live traffic. Its **Publish this solution** field asks you to accept those
warnings and effects and approve that exact publication. Your explicit Yes
publishes directly through the kit using your existing permissions. No
separate chat confirmation is needed. No or Cancel publishes nothing.

Changed readiness findings invalidate the preview, just as changed edits or
versions do. After the MCP form's Yes, the kit reads the review again before
requesting the instance's confirmation and publishing. A changed review
requires a fresh preview and approval; the instance still checks versions,
waiting runs and readiness at publication time. A warning is something you
can knowingly accept; a blocker cannot be overridden by the kit.

Without a usable MCP form, the kit supplies the command for you to run in your
own terminal after reviewing the findings. It does not open a separate web
page or give the agent a way to answer for you. The terminal flow uses the
same publication API and permissions.

### Discard or roll back

For an environment selected through `env/<name>.yaml`, pass `--env <name>` on
inspection and mutation commands; the printed confirmation retains it.

To discard unpublished work, preview first:

```bash
cavelon harness discard-draft --harness <solution>
```

Only the draft is removed after the person's confirmation. This differs from
`apply --discard`, which only forgets a local import preview.

To restore the previous pinned published version as a new publication:

```bash
cavelon harness rollback --harness <solution>
```

Use `--snapshot <id>` to choose an earlier pinned version from the publication
inspection's `published_snapshots`. The preview reviews that exact target and
its affected waiting runs. Rollback retains existing unpublished edits in a
pinned recovery snapshot and clears the working draft; the result reports its
recovery warning. Readiness problems are warnings on this emergency path and
are rechecked on the restored version. Authorization and the person's
confirmation still apply.

The corresponding MCP tools are `harness_publication`, `solution_publish`,
`harness_discard_draft` and `harness_rollback`. They use the same implementation,
version checks and confirmation flow as the CLI.

A person's dashboard session or PAT chat uses Playground preview only with
`playground.use`; the instance decides that permission. API-key chat remains
published traffic, even if a client supplies a Playground source. Saved suite
execution uses the instance's internal test identity to preview the draft.
Triggers and channels stay on the published graph. Use the run's own metadata
to identify what was executed rather than treating every chat as a draft test.
