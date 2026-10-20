import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const configured = {
  AZURE_TENANT_ID: "example-tenant", AZURE_CLIENT_ID: "example-client",
  AZURE_SIGNING_ENDPOINT: "https://weu.codesigning.azure.net/",
  AZURE_SIGNING_ACCOUNT: "example-account", AZURE_CERTIFICATE_PROFILE: "example-profile",
};

function resolveSigning(extra: Record<string, string>) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cavelon-signing-"));
  const output = path.join(dir, "output");
  try {
    const env = { ...process.env, RUNNER_OS: "Windows", AZURE_SIGNING_AUTH: "", AZURE_CLIENT_SECRET: "",
      MACOS_CERTIFICATE_P12: "", APPLE_API_KEY_P8: "", ...configured, ...extra, GITHUB_OUTPUT: output };
    const result = spawnSync(process.execPath, [path.join(root, ".github/scripts/signing-config.mjs")], { env, encoding: "utf8" });
    return { ...result, output: result.status === 0 ? readFileSync(output, "utf8") : "" };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

it("enables OIDC signing without a stored client secret", () => {
  const result = resolveSigning({ AZURE_SIGNING_AUTH: "oidc" });
  expect(result.status, result.stderr).toBe(0);
  expect(result.output).toContain("windows=true\nwindows_auth=oidc\n");
  for (const value of Object.values(configured)) expect(result.stdout).toContain(`::add-mask::${value}\n`);
});

it("preserves existing secret-based signing without logging the credential", () => {
  const result = resolveSigning({ AZURE_CLIENT_SECRET: "synthetic-secret-never-log" });
  expect(result.status, result.stderr).toBe(0);
  expect(result.output).toContain("windows=true\nwindows_auth=secret\n");
  expect(result.stdout + result.stderr + result.output).not.toContain("synthetic-secret-never-log");
});

it.each(Object.keys(configured))("refuses incomplete enabled signing when %s is missing", (name) => {
  const result = resolveSigning({ AZURE_SIGNING_AUTH: "oidc", [name]: "" });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(name);
  expect(result.output).toBe("");
});

it("refuses an unknown authentication mode instead of publishing unsigned", () => {
  const result = resolveSigning({ AZURE_SIGNING_AUTH: "mistyped" });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("AZURE_SIGNING_AUTH");
});

it("refuses explicitly enabled secret signing without its credential", () => {
  const result = resolveSigning({ AZURE_SIGNING_AUTH: "secret" });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("AZURE_CLIENT_SECRET");
});

it("leaves an unconfigured Windows release unsigned", () => {
  const result = resolveSigning({});
  expect(result.status).toBe(0);
  expect(result.output).toContain("windows=false\nwindows_auth=none\n");
});

it("preserves macOS signing and ignores Windows settings on other runners", () => {
  const result = resolveSigning({ RUNNER_OS: "macOS", AZURE_SIGNING_AUTH: "oidc", AZURE_CLIENT_ID: "",
    MACOS_CERTIFICATE_P12: "synthetic-p12", APPLE_API_KEY_P8: "synthetic-p8" });
  expect(result.status, result.stderr).toBe(0);
  expect(result.output).toContain("macos=true\nnotarize=true\nwindows=false\n");
  expect(result.stdout + result.stderr).not.toContain("synthetic-");
});

it("keeps OIDC login and signing behind the protected release environment", () => {
  const workflow = parse(readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8"));
  const job = workflow.jobs.executables;
  expect(workflow.on.push.tags).toEqual(["v*"]);
  expect(job.environment).toBe("release");
  expect(job.permissions["id-token"]).toBe("write");
  const login = job.steps.find((step: any) => step.name === "Log in to Azure for Windows signing (OIDC)");
  expect(login.if).toContain("windows_auth == 'oidc'");
  expect(login.uses).toMatch(/^azure\/login@[a-f0-9]{40}$/);
  expect(login.with["allow-no-subscriptions"]).toBe(true);
  const signing = job.steps.find((step: any) => step.name === "Sign (Windows, Azure Artifact Signing)");
  expect(signing.with["azure-client-secret"]).toContain("windows_auth == 'secret'");
  expect(signing.with["exclude-environment-credential"]).toContain("windows_auth == 'oidc'");
  expect(signing.with["exclude-azure-cli-credential"]).toContain("windows_auth != 'oidc'");
});
