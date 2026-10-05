# Releasing

A release publishes `@cavelon/cli` to npm through
`.github/workflows/release.yml`: a `v*` tag starts it, npm's trusted publishing
(OIDC, no stored token) lets it only *stage* the version, and a maintainer
approves the staged version with two-factor authentication. No token is created
or typed for it anywhere.

The same run then builds the standalone executables, attests them, and
creates the GitHub release that the one-line install downloads from: the five
executables, `checksums.txt`, `install.sh` and `install.ps1`. It updates the
Homebrew tap and writes the winget manifest when those are set up
([One-time setup](#one-time-setup)).

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
   `npm stage publish --access public`. Then `executables` builds each
   executable on its platform, signs it where the signing secrets are set, and
   runs its smoke test; `attest` writes `checksums.txt` and the build
   provenance attestations; `github-release` creates the release (a re-run
   replaces its files); `homebrew` and `winget` follow.
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

7. **Check the GitHub release** has the five executables, `checksums.txt`,
   `install.sh` and `install.ps1`, and that an executable's provenance checks
   out:

   ```bash
   gh release view vX.Y.Z --json assets --jq '.assets[].name'
   gh release download vX.Y.Z -p cavelon-linux-x64 && gh attestation verify cavelon-linux-x64 --repo goodguys-gmbh/cavelon-dev-kit
   ```

8. **Submit the winget manifest** once winget is set up: download the run's
   `winget-manifest` artifact and submit it ([winget](#winget)).
9. **Check it on a clean machine:** the one-line install (macOS, Linux and
   Windows), `npx -y @cavelon/cli whoami` and the plugin installed from the
   marketplace answer against an instance, and the
   [getting-started tutorial](docs/getting-started.md) runs as written.

## One-time setup

Until these are set up, the release workflow skips the step and says so; the
executables are released unsigned, and the docs say what users see then.
Secrets go into the `release` environment (Settings → Environments →
`release`), which accepts only `v*` tags, so no branch's workflow can read them;
the names that are not secret go into its variables.

### macOS signing and notarisation

Needs an Apple Developer Program membership of the company and a
**Developer ID Application** certificate.

| Name | Kind | What |
|---|---|---|
| `MACOS_CERTIFICATE_P12` | secret | the certificate with its private key, exported as `.p12`, base64-encoded (`base64 -i cert.p12`) |
| `MACOS_CERTIFICATE_PASSWORD` | secret | the `.p12`'s password |
| `MACOS_SIGNING_IDENTITY` | variable | the certificate's name, such as `Developer ID Application: <company> (<team id>)` |
| `APPLE_API_KEY_P8` | secret | an App Store Connect API key (role Developer) for `notarytool`, the `.p8` file base64-encoded |
| `APPLE_API_KEY_ID`, `APPLE_API_ISSUER_ID` | variables | that key's id and its issuer id |

The workflow signs with the hardened runtime and the entitlements in
`packaging/macos/entitlements.plist` (Bun's runtime compiles JavaScript at run
time and loads the credential store binding it carries), checks the
signature, and notarises. A bare executable cannot be stapled; Gatekeeper
looks the notarisation up online the first time.

### Windows signing

Set up for [Azure Artifact Signing](https://learn.microsoft.com/azure/artifact-signing/)
(formerly Trusted Signing): an Azure subscription, a signing account, an
identity validation of the company and a public-trust certificate profile, and
an app registration that holds the certificate profile signer role on that
account.

| Name | Kind | What |
|---|---|---|
| `AZURE_CLIENT_SECRET` | secret | the app registration's client secret |
| `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` | variables | the app registration's directory and client id |
| `AZURE_SIGNING_ENDPOINT` | variable | the signing account's endpoint, such as `https://weu.codesigning.azure.net/` |
| `AZURE_SIGNING_ACCOUNT`, `AZURE_CERTIFICATE_PROFILE` | variables | the signing account's and the certificate profile's names |

A certificate from another authority lives in a hardware token or a cloud HSM
since 2023; replace the signing step with that provider's tool then.

### Homebrew tap

1. Create the public repository `goodguys-gmbh/homebrew-cavelon` with a
   `README.md` and an empty `Formula/` folder. Users then install with
   `brew install goodguys-gmbh/cavelon/cavelon`.
2. Create a fine-grained personal access token (or a GitHub App token) with
   **Contents: read and write** on that repository only, and store it as the
   secret `HOMEBREW_TAP_TOKEN` of the `release` environment.
3. The next release writes `Formula/cavelon.rb` (`packaging/render.mjs
   homebrew`) and pushes it. To publish the current release right away, put
   its `checksums.txt` into `release/`, run that script from the repository's
   root at the release's tag, and commit `packaging-out/homebrew/Formula/cavelon.rb`
   to the tap by hand.
4. Announce it: the changelog, and in `docs/installation.md` drop the note that
   the tap is being prepared.

**Set up on 2026-10-04.** The tap exists and the token is in place: a
fine-grained token named `homebrew-cavelon release`, owned by `goodguys-gmbh`,
limited to that repository, which **expires on 2027-10-05** (the organisation
allows at most 366 days). After that date the `homebrew` job fails to push and
the formula stays on the last version, while the rest of the release still
succeeds. Before then, create a new token the same way and replace the secret
`HOMEBREW_TAP_TOKEN`; the reminder is the issue "Renew HOMEBREW_TAP_TOKEN before
2027-10-05". A failed `homebrew` job in a release run means the same.

### winget

The release workflow writes the manifest for each version
(`manifests/g/goodguys/Cavelon/<version>/`, `packaging/render.mjs winget`) and
keeps it as the run's `winget-manifest` artifact. The package identifier is
`goodguys.Cavelon`; change `WINGET_ID` in `packaging/render.mjs` before the
first submission if you want another.

1. Check it on Windows: `winget validate --manifest <folder>`, and
   `winget install --manifest <folder>` after
   `winget settings --enable LocalManifestFiles`.
2. Submit it as a pull request to
   [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs), adding
   the folder under `manifests/`, or with
   [wingetcreate](https://github.com/microsoft/winget-create):
   `wingetcreate submit <folder>`. Microsoft's validation runs on the pull
   request; the first one is reviewed by a person.
3. For later versions, `wingetcreate update goodguys.Cavelon --version X.Y.Z
   --urls <the release's cavelon-windows-x64.exe URL> --submit` does the same.
   An unsigned executable may be held up by the validation's SmartScreen
   check; signing (above) avoids that.
