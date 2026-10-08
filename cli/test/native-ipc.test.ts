import { expect, it } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync, chmodSync, symlinkSync } from "node:fs";
import { createConnection } from "node:net";
import os from "node:os";
import path from "node:path";
import { startUiSocket, callUi, NativeUiUnavailable } from "../src/native-approval/ipc.js";

it("decodes split UTF-8 frames, rejects approval-answer messages and cleans private resources", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cav-ipc-"));
  const calls: unknown[] = [];
  const ui = await startUiSocket(root, () => "session", async (name, args) => { calls.push({ name, args }); return args; });
  const descriptor = JSON.parse(readFileSync(ui.descriptor, "utf8"));
  const send = (request: any) => new Promise<any>((resolve, reject) => {
    const socket = createConnection(descriptor.address);
    let output = "";
    socket.on("error", reject);
    socket.on("data", chunk => { output += chunk.toString(); });
    socket.once("end", () => resolve(JSON.parse(output)));
    socket.once("connect", async () => {
      const bytes = Buffer.from(JSON.stringify({ ...request, key: descriptor.key }) + "\n");
      // Split inside the multibyte character, with a turn between writes.
      const offset = bytes.indexOf(Buffer.from("東京")) + 1;
      socket.write(bytes.subarray(0, offset));
      await new Promise(resolve => setTimeout(resolve, 5));
      socket.write(bytes.subarray(offset));
    });
  });
  try {
    expect(await send({ operation: "call", session: "session", name: "read", arguments: { text: "Grüße 東京 🐳" } })).toEqual({ result: { text: "Grüße 東京 🐳" } });
    expect(await send({ operation: "answer", session: "session", approve: true })).toHaveProperty("error");
    expect(await send({ operation: "call", session: "other", name: "read", arguments: {} })).toHaveProperty("error");
    expect(calls).toHaveLength(1);
  } finally { await ui.close(); }
  expect(existsSync(root)).toBe(false);
  await ui.close();
});

it("never chooses between two TUIs displaying the same session", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cav-ipc-"));
  let calls = 0;
  const invoke = async () => { calls++; return {}; };
  const first = await startUiSocket(root, () => "session", invoke);
  const second = await startUiSocket(root, () => "session", invoke);
  try {
    await expect(callUi(root, "session", "read", {})).rejects.toThrow("Multiple");
    expect(calls).toBe(0);
    await first.close();
    expect(await callUi(root, "session", "read", {})).toEqual({});
    expect(calls).toBe(1);
  } finally { await first.close(); await second.close(); }
});

it("disconnect aborts a dispatched call and does not reclassify its outcome as unavailable", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cav-ipc-"));
  let calls = 0;
  let aborted = false;
  let started!: () => void;
  const dispatched = new Promise<void>(resolve => { started = resolve; });
  const ui = await startUiSocket(root, () => "session", async (_name, _args, _session, signal) => {
    calls++; started();
    await new Promise<void>(resolve => signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
    return {};
  });
  const controller = new AbortController();
  try {
    const pending = callUi(root, "session", "change", {}, controller.signal);
    const rejected = expect(pending).rejects.not.toBeInstanceOf(NativeUiUnavailable);
    await dispatched;
    controller.abort();
    await rejected;
    await ui.close();
    expect(calls).toBe(1);
    expect(aborted).toBe(true);
  } finally { await ui.close(); }
});

it.skipIf(process.platform === "win32")("refuses foreign permissions and symlinks instead of repairing a shared directory", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cav-ipc-"));
  const target = path.join(root, "link");
  try {
    chmodSync(root, 0o755);
    await expect(startUiSocket(root, () => "session", async () => ({}))).rejects.toThrow("private");
    chmodSync(root, 0o700);
    symlinkSync(root, target);
    await expect(startUiSocket(target, () => "session", async () => ({}))).rejects.toThrow("private");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
