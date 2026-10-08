import { nativeStdioClient, type NativeApprovalClient } from "./client.js";
import { startUiSocket } from "./ipc.js";
import { loadNativeRuntime, type NativeRuntime } from "./profile.js";
import { previewPages } from "./preview-pages.js";

/** The minimal native host contract: no UI framework or credential binding is bundled. */
export interface OpenCodeTui {
  route: { readonly current: { name: string; params?: { sessionID?: string } } };
  state: { path: { directory: string } };
  renderer: { width: number; height: number };
  lifecycle: { onDispose(callback: () => Promise<void>): unknown };
  ui: {
    DialogAlert(props: { title: string; message: string; onConfirm: () => void }): unknown;
    DialogConfirm(props: { title: string; message: string; onConfirm: () => void; onCancel: () => void }): unknown;
    dialog: { readonly open: boolean; replace(render: () => unknown, close: () => void): void; clear(): void; setSize(size: "large"): void };
  };
}

export async function startOpenCodeTui(api: OpenCodeTui, options: NativeRuntime) {
  const clients = new Map<string, Promise<NativeApprovalClient>>();
  const pending = new Set<AbortController>();
  const retiring = new Set<Promise<void>>();
  let disposed = false;
  const session = () => api.route.current.name === "session" ? api.route.current.params?.sessionID : undefined;
  const retire = (id: string, opening: Promise<NativeApprovalClient>) => {
    if (clients.get(id) !== opening) return;
    clients.delete(id);
    const closing = opening.then(client => client.close()).catch(() => undefined);
    retiring.add(closing);
    void closing.finally(() => retiring.delete(closing));
  };
  const reap = setInterval(() => {
    for (const [id, opening] of clients) if (id !== session()) retire(id, opening);
  }, 100);
  reap.unref();
  const connect = async (id: string) => {
    if (disposed) throw new Error("Cavelon adapter closed.");
    const previous = clients.get(id);
    if (previous && (await previous).closed && clients.get(id) === previous) clients.delete(id);
    if (!clients.has(id)) {
      const opening = nativeStdioClient({ ...options.command, cwd: api.state.path.directory }, true, options.version);
      clients.set(id, opening);
      opening.catch(() => { if (clients.get(id) === opening) clients.delete(id); });
    }
    return clients.get(id)!;
  };
  const ask = (message: string, signal: AbortSignal) => new Promise<boolean>(resolve => {
    if (signal.aborted || api.ui.dialog.open || disposed) { resolve(false); return; }
    let pages: string[];
    try { pages = previewPages(message, api.renderer.width, api.renderer.height); }
    catch { resolve(false); return; }
    let done = false;
    let page = 0;
    let replacing = false;
    const finish = (answer: boolean, clear = true) => {
      if (done) return;
      done = true;
      signal.removeEventListener("abort", cancel);
      if (clear) api.ui.dialog.clear();
      resolve(answer === true && !signal.aborted && !disposed);
    };
    const cancel = () => finish(false);
    const closed = () => { if (!replacing) finish(false, false); };
    const show = () => {
      if (signal.aborted) { finish(false); return; }
      // Replacing our own page must not be interpreted as closing the approval.
      replacing = true;
      api.ui.dialog.replace(() => pages.length > 1 && page < pages.length
        ? api.ui.DialogAlert({ title: `Cavelon preview ${page + 1}/${pages.length}`, message: pages[page]!, onConfirm: () => {
          // The native alert clears itself after this callback. Open the next
          // page only after that clear, without interpreting it as refusal.
          replacing = true;
          page++;
          queueMicrotask(() => {
            replacing = false;
            if (done) return;
            if (api.ui.dialog.open) finish(false, false);
            else show();
          });
        } })
        : api.ui.DialogConfirm({
          title: "Cavelon: approve this exact change",
          message: pages.length === 1 ? message : `Approve the exact change shown in all ${pages.length} preview pages?`,
          onConfirm: () => finish(true), onCancel: cancel,
        }), closed);
      api.ui.dialog.setSize("large");
      replacing = false;
    };
    signal.addEventListener("abort", cancel, { once: true });
    show();
  });
  const socket = await startUiSocket(options.runtimeDir, session, async (name, args, id, callerSignal) => {
    const controller = new AbortController();
    pending.add(controller);
    const abort = () => controller.abort();
    callerSignal.addEventListener("abort", abort, { once: true });
    const timer = setInterval(() => { if (session() !== id) controller.abort(); }, 100);
    try {
      if (callerSignal.aborted || session() !== id || disposed) throw new Error("Native UI session changed.");
      const bridge = await connect(id);
      return await bridge.call(name, args, { signal: controller.signal, ask });
    } finally {
      clearInterval(timer);
      pending.delete(controller);
      callerSignal.removeEventListener("abort", abort);
    }
  }).catch(error => { clearInterval(reap); throw error; });
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= (async () => {
    disposed = true;
    clearInterval(reap);
    for (const controller of pending) controller.abort();
    await socket.close();
    await Promise.all([...clients.values()].map(async opening => (await opening.catch(() => undefined))?.close()));
    await Promise.all(retiring);
    clients.clear();
  })();
  api.lifecycle.onDispose(close);
  return { close, descriptor: socket.descriptor };
}

export default {
  id: "cavelon.native-approval",
  async tui(api: OpenCodeTui, options: { profile?: unknown } | undefined) {
    if (typeof options?.profile !== "string") throw new Error("Cavelon native approval needs its setup profile.");
    await startOpenCodeTui(api, await loadNativeRuntime(options.profile, "opencode"));
  },
};
