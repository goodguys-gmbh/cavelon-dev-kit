import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeFileAtomic } from "../src/fsutil.js";
import { resolveGit } from "../src/git.js";

/**
 * goodguys-gmbh/cavelon-dev-kit#4: the kit runs git from an absolute PATH
 * directory only, and never widens a file's permissions.
 */

const posix = process.platform !== "win32";
const temp = () => mkdtempSync(path.join(tmpdir(), "cavelon-files-"));

function fakeGit(dir: string, name: string, mode = 0o755): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, "#!/bin/sh\n");
  chmodSync(file, mode);
  return file;
}

describe("resolveGit", () => {
  it.runIf(posix)("skips relative PATH entries and finds git in an absolute one", async () => {
    const root = temp();
    fakeGit(path.join(root, "bin"), "git");
    const installed = fakeGit(path.join(root, "usr", "bin"), "git");
    const env = { PATH: ["", ".", "bin", path.join(root, "usr", "bin")].join(":") };
    const cwd = process.cwd();
    process.chdir(root);
    try {
      expect(await resolveGit(env, "linux")).toBe(installed);
    } finally {
      process.chdir(cwd);
    }
  });

  it.runIf(posix)("skips a git that is not executable", async () => {
    const root = temp();
    fakeGit(path.join(root, "a"), "git", 0o644);
    const installed = fakeGit(path.join(root, "b"), "git");
    expect(await resolveGit({ PATH: `${path.join(root, "a")}:${path.join(root, "b")}` }, "linux")).toBe(installed);
  });

  it("is undefined when no absolute PATH entry holds git", async () => {
    expect(await resolveGit({ PATH: "" }, process.platform)).toBeUndefined();
    expect(await resolveGit({}, process.platform)).toBeUndefined();
  });

  it.runIf(!posix)("looks for git.exe on Windows, also in a quoted entry", async () => {
    const root = temp();
    const installed = fakeGit(path.join(root, "Git", "cmd"), "git.exe");
    expect(await resolveGit({ Path: `.;"${path.join(root, "Git", "cmd")}"` }, "win32")).toBe(installed);
  });

  it("finds the git this machine has", async () => {
    const found = await resolveGit();
    if (found) expect(path.isAbsolute(found)).toBe(true);
  });
});

describe.runIf(posix)("writeFileAtomic", () => {
  const mode = (file: string) => statSync(file).mode & 0o777;

  it("creates a file with the given mode", async () => {
    const file = path.join(temp(), "nested", "secret.json");
    await writeFileAtomic(file, "{}", 0o600, 0o700);
    expect(readFileSync(file, "utf8")).toBe("{}");
    expect(mode(file)).toBe(0o600);
    expect(mode(path.dirname(file))).toBe(0o700);
  });

  it("narrows a replaced file to the given mode", async () => {
    const file = path.join(temp(), "credentials.json");
    writeFileSync(file, "old");
    chmodSync(file, 0o644);
    await writeFileAtomic(file, "new", 0o600);
    expect(readFileSync(file, "utf8")).toBe("new");
    expect(mode(file)).toBe(0o600);
  });

  it("never widens a replaced file", async () => {
    const file = path.join(temp(), "solution.yaml");
    writeFileSync(file, "old");
    chmodSync(file, 0o600);
    await writeFileAtomic(file, "new");
    expect(mode(file)).toBe(0o600);
  });

  it("keeps an executable file executable when asked for its own mode", async () => {
    const file = path.join(temp(), "pre-commit");
    writeFileSync(file, "#!/bin/sh\n");
    chmodSync(file, 0o755);
    await writeFileAtomic(file, "#!/bin/sh\nexit 0\n", 0o755);
    expect(mode(file)).toBe(0o755);
  });
});
