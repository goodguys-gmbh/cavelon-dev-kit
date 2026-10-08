import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { bundledNativeAssets } from "../src/native-assets.js";
import { KIT_VERSION } from "../src/version.js";

const embedded = vi.hoisted(() => ({ value: undefined as any }));
vi.mock("../src/embedded.js", () => ({ embeddedContent: () => embedded.value }));

function bundle(content = "Grüße 東京 🐳") {
  const file = { path: "pi-extension.mjs", content };
  const manifest = { format: 1, version: KIT_VERSION, files: [{ path: file.path, size: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex") }] };
  return [file, { path: "manifest.json", content: JSON.stringify(manifest) }];
}

it("verifies embedded Unicode assets before returning a copy for setup", async () => {
  const assets = bundle();
  embedded.value = { version: KIT_VERSION, skills: [], nativeAssets: assets };
  expect(await bundledNativeAssets()).toEqual([...assets].sort((a, b) => a.path.localeCompare(b.path, "en")));
});

it("refuses changed bytes, incomplete inventories, duplicate paths and foreign versions", async () => {
  const invalid = [
    [{ ...bundle()[0], content: "tampered" }, bundle()[1]],
    [bundle()[1]],
    [...bundle(), { path: "extra.mjs", content: "personal" }],
    bundle().map(file => file.path === "manifest.json" ? { ...file, content: file.content.replace(KIT_VERSION, "99.0.0") } : file),
  ];
  for (const assets of invalid) {
    embedded.value = { version: KIT_VERSION, skills: [], nativeAssets: assets };
    await expect(bundledNativeAssets()).rejects.toThrow();
  }
  const duplicate = bundle();
  const repeated = JSON.parse(duplicate[1]!.content);
  repeated.files.push(repeated.files[0]);
  duplicate[1]!.content = JSON.stringify(repeated);
  duplicate.push(duplicate[0]!);
  embedded.value = { version: KIT_VERSION, skills: [], nativeAssets: duplicate };
  await expect(bundledNativeAssets()).rejects.toThrow("path");
  const assets = bundle();
  const manifest = JSON.parse(assets[1]!.content);
  manifest.files[0].path = "../personal";
  assets[1]!.content = JSON.stringify(manifest);
  embedded.value = { version: KIT_VERSION, skills: [], nativeAssets: assets };
  await expect(bundledNativeAssets()).rejects.toThrow("path");
});
