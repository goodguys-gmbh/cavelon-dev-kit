import { promises as fs, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { writeFileAtomic } from "../src/fsutil.js";

const nativeProcess = process;
const rename = fs.rename.bind(fs);
let directory: string;
let file: string;

beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "cavelon-atomic-"));
  file = path.join(directory, "openapi.json.meta.json");
  writeFileSync(file, "old complete metadata", { mode: 0o600 });
  vi.stubGlobal("process", Object.create(nativeProcess, { platform: { value: "win32" } }));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(directory, { recursive: true, force: true });
});

it.each(["EPERM", "EACCES", "EBUSY"])("retries a transient Windows target lock (%s) without deleting the old file", async code => {
  const heldOpen = Object.assign(new Error("Synthetic target is held open"), { code });
  const calls = vi.spyOn(fs, "rename").mockImplementationOnce(async () => {
    expect(readFileSync(file, "utf8")).toBe("old complete metadata");
    throw heldOpen;
  }).mockImplementation(rename);
  await writeFileAtomic(file, "new complete metadata", 0o600);
  expect(calls).toHaveBeenCalledTimes(2);
  expect(readFileSync(file, "utf8")).toBe("new complete metadata");
  expect(readdirSync(directory)).toEqual([path.basename(file)]);
});

it("bounds Windows lock retries and preserves the old file when the lock stays held", async () => {
  const heldOpen = Object.assign(new Error("Synthetic permanent target lock"), { code: "EPERM" });
  const calls = vi.spyOn(fs, "rename").mockRejectedValue(heldOpen);
  await expect(writeFileAtomic(file, "unpublished metadata", 0o600)).rejects.toBe(heldOpen);
  expect(calls).toHaveBeenCalledTimes(6);
  expect(readFileSync(file, "utf8")).toBe("old complete metadata");
  expect(readdirSync(directory)).toEqual([path.basename(file)]);
});

it.each(["win32", "linux"])("does not retry an unrelated rename error on %s, and removes its temporary copy", async platform => {
  vi.stubGlobal("process", Object.create(nativeProcess, { platform: { value: platform } }));
  const failure = Object.assign(new Error("Synthetic invalid rename"), { code: "EINVAL" });
  const calls = vi.spyOn(fs, "rename").mockRejectedValue(failure);
  await expect(writeFileAtomic(file, "unpublished metadata", 0o600)).rejects.toBe(failure);
  expect(calls).toHaveBeenCalledTimes(1);
  expect(readFileSync(file, "utf8")).toBe("old complete metadata");
  expect(readdirSync(directory)).toEqual([path.basename(file)]);
});

it("does not reinterpret a Unix permission error as a Windows sharing lock", async () => {
  vi.stubGlobal("process", Object.create(nativeProcess, { platform: { value: "linux" } }));
  const failure = Object.assign(new Error("Synthetic Unix permission error"), { code: "EPERM" });
  const calls = vi.spyOn(fs, "rename").mockRejectedValue(failure);
  await expect(writeFileAtomic(file, "unpublished metadata", 0o600)).rejects.toBe(failure);
  expect(calls).toHaveBeenCalledTimes(1);
  expect(readFileSync(file, "utf8")).toBe("old complete metadata");
});
