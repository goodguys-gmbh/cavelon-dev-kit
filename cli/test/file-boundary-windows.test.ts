import { describe, expect, it, vi } from "vitest";

// Bun 1.4.2's promise API removes a Windows root's final separator, while
// realpath.native preserves it (oven-sh/bun#42581). Exercise both API contracts
// on every test host; the standalone smoke tests exercise the actual runtime.
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const resolve = (file: string): string => {
    if (file === "C:\\" || file === "D:\\") return file;
    throw Object.assign(new Error("No such file or directory"), { code: "ENOENT" });
  };
  const realpath = (file: string, callback: (error: NodeJS.ErrnoException | null, result?: string) => void) => {
    try { callback(null, resolve(file)); }
    catch (error) { callback(error as NodeJS.ErrnoException); }
  };
  return {
    ...actual,
    promises: { ...actual.promises, realpath: async (file: string) => resolve(file).slice(0, -1) },
    realpath: Object.assign(realpath, { native: realpath }),
  };
});
vi.mock("node:path", async importOriginal => {
  const actual = await importOriginal<typeof import("node:path")>();
  return { ...actual, default: actual.win32 };
});

import { realPath, solutionPath } from "../src/file-boundary.js";

describe("Windows drive-root real paths", () => {
  it.each(["C:\\", "D:\\"])("preserves %s and permits missing manifest children during discovery", async root => {
    expect(await realPath(root)).toBe(root);
    expect(await solutionPath(root, `${root}cavelon.yaml`)).toBe(`${root}cavelon.yaml`);
  });
});
