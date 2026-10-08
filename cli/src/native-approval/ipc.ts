import { createConnection, createServer, type Socket } from "node:net";
import { randomUUID, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { PERSON_WAIT_MS } from "../approval-policy.js";

const MAX_FRAME = 4 * 1024 * 1024;
const MAX_UIS = 16;
export class NativeUiUnavailable extends Error {}

interface Descriptor { address: string; key: string }
type Invoke = (name: string, args: Record<string, unknown>, session: string, signal: AbortSignal) => Promise<unknown>;

async function privatePath(file: string, directory: boolean): Promise<void> {
  const stat = await fs.lstat(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())
    || (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) {
    throw new Error("The native UI path must be private and owned by this person.");
  }
}

function frame(consume: (input: string) => void, fail: () => void): (chunk: Buffer) => void {
  const decoder = new StringDecoder("utf8");
  let input = "";
  let bytes = 0;
  let done = false;
  return chunk => {
    if (done) return;
    bytes += chunk.length;
    if (bytes > MAX_FRAME) { done = true; fail(); return; }
    input += decoder.write(chunk);
    const end = input.indexOf("\n");
    if (end < 0) return;
    done = true;
    consume(input.slice(0, end));
  };
}

/** IPC exposes tool calls only. The TUI owns the connection and every answer. */
export async function startUiSocket(directory: string, currentSession: () => string | undefined, invoke: Invoke) {
  await fs.mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
  await privatePath(directory, true);
  const privateDir = await fs.mkdtemp(path.join(directory, "tui-"));
  await fs.chmod(privateDir, 0o700);
  const key = randomBytes(32).toString("hex");
  const address = process.platform === "win32" ? `\\\\.\\pipe\\cavelon-ui-${randomUUID()}` : path.join(privateDir, "ui.sock");
  if (process.platform !== "win32" && Buffer.byteLength(address) > 103) {
    await fs.rm(privateDir, { recursive: true, force: true });
    throw new Error("Native UI socket path is too long; use the short Cavelon runtime directory.");
  }
  const descriptor = path.join(privateDir, "runtime.json");
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    const abort = new AbortController();
    const timer = setTimeout(() => { abort.abort(); socket.destroy(); }, PERSON_WAIT_MS + 15_000);
    socket.on("close", () => { clearTimeout(timer); sockets.delete(socket); abort.abort(); });
    socket.on("error", () => abort.abort());
    socket.on("data", frame(input => {
      void (async () => {
        try {
          const request = JSON.parse(input) as Record<string, unknown>;
          if (request.key !== key) throw new Error("Unbound native UI request.");
          let result: unknown;
          if (request.operation === "hello") result = { session: currentSession() };
          else if (request.operation === "call" && typeof request.session === "string" && currentSession() === request.session
            && typeof request.name === "string" && request.arguments && typeof request.arguments === "object" && !Array.isArray(request.arguments)) {
            result = await invoke(request.name, request.arguments as Record<string, unknown>, request.session, abort.signal);
          } else throw new Error("No native tool call for this session.");
          const output = JSON.stringify({ result }) + "\n";
          if (Buffer.byteLength(output) > MAX_FRAME) throw new Error("Native UI response too large.");
          if (!socket.destroyed) socket.end(output);
        } catch {
          // Process/configuration failures can contain private environment values.
          if (!socket.destroyed) socket.end(JSON.stringify({ error: "Native UI call failed; its outcome may be unknown. Do not retry automatically." }) + "\n");
        }
      })();
    }, () => socket.destroy()));
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(address, resolve); });
    if (process.platform !== "win32") await fs.chmod(address, 0o600);
    await fs.writeFile(descriptor, JSON.stringify({ address, key }) + "\n", { mode: 0o600, flag: "wx" });
  } catch (error) {
    server.close();
    await fs.rm(privateDir, { recursive: true, force: true });
    throw error;
  }
  let closing: Promise<void> | undefined;
  return {
    descriptor,
    close(): Promise<void> {
      return closing ??= (async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>(resolve => server.close(() => resolve()));
        await fs.rm(privateDir, { recursive: true, force: true });
        // Another TUI can still own this shared root.
        await fs.rmdir(directory).catch(() => undefined);
      })();
    },
  };
}

async function requestSocket(descriptor: string, body: Record<string, unknown>, signal: AbortSignal | undefined, timeout: number): Promise<unknown> {
  await privatePath(path.dirname(descriptor), true);
  await privatePath(descriptor, false);
  const parsed = JSON.parse(await fs.readFile(descriptor, "utf8")) as Descriptor;
  if (typeof parsed.key !== "string" || !/^[a-f0-9]{64}$/.test(parsed.key) || typeof parsed.address !== "string"
    || (process.platform === "win32" ? !/^\\\\\.\\pipe\\cavelon-ui-[a-f0-9-]+$/.test(parsed.address) : parsed.address !== path.join(path.dirname(descriptor), "ui.sock"))) {
    throw new Error("Invalid native UI descriptor.");
  }
  if (signal?.aborted) throw new Error("Cavelon call cancelled.");
  return new Promise((resolve, reject) => {
    const socket = createConnection(parsed.address);
    const timer = setTimeout(() => socket.destroy(new Error("Native UI timeout.")), timeout);
    const abort = () => socket.destroy(new Error("Cavelon call cancelled."));
    signal?.addEventListener("abort", abort, { once: true });
    let done = false;
    const finish = (error?: Error, value?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.once("connect", () => {
      const output = JSON.stringify({ ...body, key: parsed.key }) + "\n";
      if (Buffer.byteLength(output) > MAX_FRAME) finish(new Error("Native UI request too large."));
      else socket.write(output);
    });
    socket.once("error", error => finish(error));
    socket.once("close", () => finish(new Error("Native UI disconnected.")));
    socket.on("data", frame(input => {
      try {
        const response = JSON.parse(input) as { error?: unknown; result?: unknown };
        finish(response.error ? new Error("Native UI call failed; do not retry automatically.") : undefined, response.result);
      } catch { finish(new Error("Invalid native UI response.")); }
    }, () => finish(new Error("Native UI response too large."))));
  });
}

export async function callUi(directory: string, session: string, name: string, args: Record<string, unknown>, signal?: AbortSignal, timeout = PERSON_WAIT_MS + 15_000): Promise<unknown> {
  try { await privatePath(directory, true); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new NativeUiUnavailable("No native TUI displays this session.");
    throw error;
  }
  const entries = (await fs.readdir(directory, { withFileTypes: true })).filter(item => item.isDirectory() && item.name.startsWith("tui-"));
  if (entries.length > MAX_UIS) throw new Error("Too many native UI descriptors; close inactive clients and inspect the runtime directory.");
  const candidates = await Promise.all(entries.map(async entry => {
    const descriptor = path.join(directory, entry.name, "runtime.json");
    try {
      const hello = await requestSocket(descriptor, { operation: "hello" }, signal, 1000) as { session?: unknown };
      return hello.session === session ? descriptor : undefined;
    } catch { return undefined; }
  }));
  if (signal?.aborted) throw new Error("Cavelon call cancelled.");
  const matches = candidates.filter((item): item is string => item !== undefined);
  if (!matches.length) throw new NativeUiUnavailable("No native TUI displays this session.");
  if (matches.length !== 1) throw new Error("Multiple native TUIs display this session; choose one before calling Cavelon.");
  // Anything failing after this dispatch has an unknown outcome: no headless retry.
  return requestSocket(matches[0]!, { operation: "call", session, name, arguments: args }, signal, timeout);
}
