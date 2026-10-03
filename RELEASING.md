# Releasing

A release publishes `@cavelon/cli` to npm through
`.github/workflows/release.yml`: a `v*` tag starts it, npm's trusted publishing
(OIDC, no stored token) lets it only *stage* the version, and a maintainer
approves the staged version with two-factor authentication. No token is created
or typed for it anywhere.

The CLI, the skills and the plugin share one version.

## Steps

1. **Open a release pull request** that:
   - sets the new version in `cli/package.json` (and runs
     `npm install --package-lock-only --ignore-scripts` for the lockfile), both
     plugin manifests and `.claude-plugin/marketplace.json`, which the tests
     hold in step;
   - for a new minor version, moves the MCP entry's pin (`@cavelon/cli@0.1`)
     in `plugin/.mcp.json` and `cli/src/agents.ts`, which the tests also check;
   - turns `CHANGELOG.md`'s **Unreleased** section into the new version, with
     the release date.
2. **Merge it** (squash) and note its commit on `main`:

   ```bash
   git fetch origin && git log -1 --format='%H %s' origin/main
   ```

3. **Tag that commit.** Only repository admins may create `v*` tags:

   ```bash
   git tag vX.Y.Z <merge commit> && git push origin vX.Y.Z
   ```

   The tag must equal `v` + `cli/package.json`'s version; the workflow stops
   otherwise.
4. **Watch the Release workflow.** `verify` runs typecheck, lint, tests and the
   build on the tagged commit; `stage-npm` (environment `release`) runs
   `npm stage publish --access public`.
5. **Approve the staged version** with an npm account that owns `@cavelon/cli`
   (two-factor authentication), on npmjs.com or with npm 11.16 or newer:

   ```bash
   npm login
   npm stage list @cavelon/cli          # the stage id of the new version
   npm stage view <stage-id>            # optional: what was staged
   npm stage download <stage-id>        # optional: the tarball, to inspect
   npm stage approve <stage-id>         # asks for the one-time code
   ```

   If the staged version is wrong, `npm stage reject <stage-id>` removes it;
   fix, merge, and tag the next patch version.
6. **Check the published package** shows the new version as `latest`, with
   provenance:

   ```bash
   npm view @cavelon/cli version dist-tags
   npm view @cavelon/cli@X.Y.Z dist.attestations --json   # "provenance": { "predicateType": "https://slsa.dev/provenance/v1" }
   npx -y @cavelon/cli@X.Y.Z --version
   ```

7. **Check it on a clean machine:** `npx -y @cavelon/cli whoami` and the plugin
   installed from the marketplace answer against an instance, and the
   [getting-started tutorial](docs/getting-started.md) runs as written.
