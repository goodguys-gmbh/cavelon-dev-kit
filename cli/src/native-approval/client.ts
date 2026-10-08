import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, type StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ElicitRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { PERSON_WAIT_MS } from "../confirm-token.js";

/** Supplied by a native UI adapter, never a model-facing argument or tool. */
export type PersonDialog = (message: string, signal: AbortSignal, timeoutMs: number) => Promise<unknown>;

interface Options {
  transport: Transport;
  interactive: boolean;
  version: string;
  waitMs?: number;
}

interface PendingCall {
  controller: AbortController;
  ask?: PersonDialog;
  dialog: boolean;
}

/** The native UI owns one MCP connection; its current call owns each fresh answer. */
export class NativeApprovalClient {
  readonly client: Client;
  readonly waitMs: number;
  closed = false;
  private tail: Promise<unknown> = Promise.resolve();
  private active?: PendingCall;
  private closing?: Promise<void>;

  constructor(private readonly options: Options) {
    this.waitMs = options.waitMs ?? PERSON_WAIT_MS;
    if (!Number.isFinite(this.waitMs) || this.waitMs <= 0 || this.waitMs > PERSON_WAIT_MS) {
      throw new Error("The native person wait must be positive and at most ten minutes.");
    }
    this.client = new Client({ name: "cavelon-native", version: options.version }, {
      capabilities: options.interactive ? { elicitation: { form: {} } } : {},
    });
    if (options.interactive) this.client.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
      const call = this.active;
      if (request.params.mode === "url") return { action: "cancel" };
      const schema = request.params.requestedSchema;
      if (!call || call.dialog || call.controller.signal.aborted || schema.type !== "object"
        || schema.required?.length !== 1 || schema.required[0] !== "approve"
        || Object.keys(schema.properties).length !== 1 || schema.properties.approve?.type !== "boolean") {
        return { action: "cancel" };
      }
      call.dialog = true;
      const signal = AbortSignal.any([call.controller.signal, extra.signal]);
      try {
        if (signal.aborted || !call.ask) return { action: "cancel" };
        const answer = await Promise.race([
          call.ask(request.params.message, signal, this.waitMs),
          new Promise<undefined>(resolve => signal.addEventListener("abort", () => resolve(undefined), { once: true })),
        ]);
        if (signal.aborted || this.active !== call || answer !== true) return { action: "decline" };
        return { action: "accept", content: { approve: true } };
      } catch {
        return { action: "cancel" };
      } finally {
        call.dialog = false;
      }
    });
    this.client.onclose = () => {
      this.closed = true;
      this.active?.controller.abort();
    };
  }

  async connect(): Promise<this> {
    try {
      await this.client.connect(this.options.transport, { timeout: 15_000 });
      return this;
    } catch (error) {
      await this.close().catch(() => undefined);
      throw error;
    }
  }

  async tools(): Promise<Tool[]> {
    const tools: Tool[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < 128; pageNumber++) {
      const page = await this.client.listTools(cursor ? { cursor } : undefined, { timeout: 15_000 });
      tools.push(...page.tools);
      if (!page.nextCursor) return tools;
      if (seen.has(page.nextCursor)) throw new Error("The Cavelon tool list repeated its pagination cursor.");
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    throw new Error("The Cavelon tool list exceeded its bounded page limit.");
  }

  call(name: string, args: Record<string, unknown> = {}, options: { signal?: AbortSignal; ask?: PersonDialog } = {}): ReturnType<Client["callTool"]> {
    const run = async () => {
      if (this.closed || options.signal?.aborted) throw new Error("Cavelon call cancelled or disconnected.");
      const controller = new AbortController();
      const active: PendingCall = { controller, ask: options.ask, dialog: false };
      const abort = () => controller.abort();
      options.signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, this.waitMs);
      this.active = active;
      try {
        return await this.client.callTool({ name, arguments: args }, undefined, {
          signal: controller.signal, timeout: this.waitMs + 15_000,
        });
      } finally {
        const cancelled = controller.signal.aborted;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        controller.abort();
        this.active = undefined;
        // Closing isolates late UI/protocol answers; a later call must connect afresh.
        if (cancelled || this.closed) await this.close();
      }
    };
    const result = this.tail.then(run, run);
    this.tail = result.catch(() => undefined);
    return result;
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.closed = true;
      this.active?.controller.abort();
      this.closing = this.client.close();
    }
    return this.closing;
  }
}

export async function nativeStdioClient(command: StdioServerParameters, interactive: boolean, version: string): Promise<NativeApprovalClient> {
  const transport = new StdioClientTransport({ ...command, stderr: "pipe" });
  // Diagnostics are not part of the model-visible protocol, but must be drained.
  transport.stderr?.on("data", () => undefined);
  return new NativeApprovalClient({ transport, interactive, version }).connect();
}
