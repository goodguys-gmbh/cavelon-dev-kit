import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function signingStep(): { run: string } {
  const workflow = parse(readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8"));
  return workflow.jobs["offline-bundle"].steps.find((step: any) => step.name === "Sign the bundle and its manifest, and verify them as a user would");
}

/** Runs the step with a cosign that fails its first `failures` sign-blob calls, as a failed OIDC fetch does. */
function runStep(failures: number) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cavelon-bundle-signing-"));
  try {
    const bin = path.join(dir, "bin");
    mkdirSync(bin);
    mkdirSync(path.join(dir, "packaging-out/bundle"), { recursive: true });
    const calls = path.join(dir, "calls");
    writeFileSync(path.join(bin, "cosign"), `#!/bin/sh
echo "$*" >> "${calls}"
if [ "$1" = sign-blob ] && [ "$(grep -c '^sign-blob' "${calls}")" -le ${failures} ]; then exit 1; fi
exit 0
`);
    // macOS has no timeout(1); the step's own limit is not what is tested here.
    writeFileSync(path.join(bin, "timeout"), '#!/bin/sh\nshift\nexec "$@"\n');
    chmodSync(path.join(bin, "cosign"), 0o755);
    chmodSync(path.join(bin, "timeout"), 0o755);
    const result = spawnSync("bash", ["-e", "-c", signingStep().run], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, NAME: "cavelon-bundle-9.9.9", SIGN_RETRY_SECONDS: "0", GITHUB_REPOSITORY: "o/r", GITHUB_REF: "refs/tags/v9.9.9" },
    });
    let log = "";
    try { log = readFileSync(calls, "utf8"); } catch { /* no call */ }
    return { status: result.status, output: result.stdout + result.stderr, calls: log.trim().split("\n").filter(Boolean) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

it("signs with GitHub's OIDC token only, so a failed token fetch never waits for a device-flow code", () => {
  const { status, calls } = runStep(0);
  expect(status).toBe(0);
  const signs = calls.filter((c) => c.startsWith("sign-blob"));
  expect(signs).toHaveLength(2);
  for (const call of signs) expect(call).toContain("--oidc-provider github-actions");
  expect(calls.filter((c) => c.startsWith("verify-blob"))).toHaveLength(2);
});

it("retries a failed signing attempt, and fails the step after three", () => {
  const retried = runStep(2);
  expect(retried.status).toBe(0);
  expect(retried.output).toContain("attempt 2 of 3");
  expect(retried.calls.filter((c) => c.startsWith("sign-blob"))).toHaveLength(4);
  const failed = runStep(3);
  expect(failed.status).not.toBe(0);
  expect(failed.calls.some((c) => c.startsWith("verify-blob"))).toBe(false);
});
