// Resolve release signing before the platform action runs. OIDC is explicit so
// an existing secret-based installation keeps its authentication method.
import { appendFileSync } from "node:fs";

const value = (name) => (process.env[name] ?? "").trim();
const fields = ["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_SIGNING_ENDPOINT", "AZURE_SIGNING_ACCOUNT", "AZURE_CERTIFICATE_PROFILE"];

try {
  let windowsAuth = "none";
  if (value("RUNNER_OS") === "Windows") {
    const mode = value("AZURE_SIGNING_AUTH") || "secret";
    if (mode !== "oidc" && mode !== "secret") throw new Error("AZURE_SIGNING_AUTH must be oidc or secret.");
    if (value("AZURE_SIGNING_AUTH") === "secret" && !value("AZURE_CLIENT_SECRET")) {
      throw new Error("Secret-based Windows signing requires AZURE_CLIENT_SECRET.");
    }
    if (mode === "oidc" || value("AZURE_CLIENT_SECRET")) {
      const missing = fields.filter((name) => !value(name));
      if (missing.length) throw new Error(`Windows signing requires: ${missing.join(", ")}.`);
      windowsAuth = mode;
    }
  }
  const output = value("GITHUB_OUTPUT");
  if (!output) throw new Error("GITHUB_OUTPUT is required.");
  if (windowsAuth !== "none") {
    // Azure's actions can print account metadata. Register masks before either
    // login or signing, keeping private identifiers out of public build logs.
    for (const name of fields) {
      const escaped = value(name).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
      process.stdout.write(`::add-mask::${escaped}\n`);
    }
  }
  const macos = value("RUNNER_OS") === "macOS" && Boolean(value("MACOS_CERTIFICATE_P12"));
  appendFileSync(output, `macos=${macos}\nnotarize=${macos && Boolean(value("APPLE_API_KEY_P8"))}\nwindows=${windowsAuth !== "none"}\nwindows_auth=${windowsAuth}\n`, "utf8");
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
