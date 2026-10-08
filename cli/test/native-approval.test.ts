import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { COMMANDS } from "../src/commands/index.js";
import { createMcpServer } from "../src/mcp.js";
import { startFakeServer, type FakeServer } from "./fake-server.js";
import { cli, login, sandbox, type Sandbox } from "./helpers.js";
import { Readable } from 'node:stream';
import { NativeApprovalClient } from "../src/native-approval/client.js";

// These are synthetic UI answers. They prove protocol behavior, not person interaction.
let fake: FakeServer;
let sb: Sandbox;
let tenant: string;
const getHarness = () => fake.state.harnesses.find(h => h.slug === 'support')!;
const confirmations = () => fake.state.requests.filter(r => r.path === '/api/v1/confirmations');
const changes = () => fake.state.requests.filter(r => r.method === 'POST' && r.path.endsWith('/deactivate'));

beforeAll(async () => {
  fake = await startFakeServer();
  tenant = fake.addTenant('acme', 'Acme');
  sb = sandbox();
  await login(sb, fake.url, fake.addToken({ kind: 'pat', tenantIds: [tenant], defaultTenant: tenant, mayActivate: true }), ['--tenant', 'acme']);
  await cli(sb, ['harness', 'new', 'support', '--name', 'Support']);
});
afterAll(async () => { sb.cleanup(); await fake.close(); });
beforeEach(() => {
  getHarness().status = 'active';
  getHarness().is_default = false;
  fake.state.confirmations = { enforced: true };
  fake.state.confirmationIds.clear();
  fake.state.requests.length = 0;
});

async function connection(interactive = true, waitMs = 2000) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const stdin = Readable.from([]) as any;
  stdin.isTTY = false;
  const server = createMcpServer({
    env: sb.env, cwd: sb.home, stdin,
    stdout: { write: () => true, isTTY: false }, stderr: { write: () => true, isTTY: false },
    now: () => new Date(), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  }, COMMANDS, { fetch: async () => { throw new Error('No external update check in native client test.'); } });
  await server.connect(serverTransport);
  const bridge = await new NativeApprovalClient({ transport: clientTransport, interactive, waitMs, version: "test" }).connect();
  const close = async () => { await bridge.close(); await server.close(); };
  return { bridge, close };
}
function body(result: any) { return JSON.parse(result.content[0].text); }

it('the existing built-in capability shape cannot approve a guarded change', async () => {
  const c = await connection(false);
  try {
    const preview = body(await c.bridge.call('deactivate', { harness: 'support' }));
    expect(preview.needs_person).toBe('terminal');
    expect(preview.confirm_token).toBeUndefined();
    expect(preview.confirm).toContain('deactivate');
    const result = body(await c.bridge.call('deactivate', { harness: 'support', confirm: preview.confirm_token ?? '000000000000' }));
    expect(result.needs_person).toBe('terminal');
    expect(result.exit_code ?? result.error?.code).toBeDefined();
    expect(confirmations()).toEqual([]);
    expect(changes()).toEqual([]);
  } finally { await c.close(); }
});

it('lists the canonical tools and preserves read results without asking', async () => {
  const c = await connection();
  let asked = false;
  try {
    expect((await c.bridge.tools()).some(tool => tool.name === 'whoami')).toBe(true);
    const result = await c.bridge.call('whoami', {}, { ask: async () => { asked = true; return true; } });
    expect(result.isError).not.toBe(true);
    const expected = (await cli(sb, ['whoami', '--json'])).json();
    expect(body(result).owner).toEqual(expected.owner);
    expect(asked).toBe(false);
    expect(confirmations()).toEqual([]);
    expect(changes()).toEqual([]);
  } finally { await c.close(); }
});

it('forwards the exact preview and asks before issuing a bound confirmation once', async () => {
  const c = await connection();
  try {
    const preview = body(await c.bridge.call('deactivate', { harness: 'support' }));
    const messages: string[] = [];
    expect(confirmations()).toEqual([]);
    const result = await c.bridge.call('deactivate', { harness: 'support', confirm: preview.confirm_token }, {
      ask: async (message: string) => { messages.push(message); expect(confirmations()).toEqual([]); return true; },
    });
    expect(result.isError).not.toBe(true);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('support');
    expect(confirmations()).toHaveLength(1);
    expect(changes()).toHaveLength(1);
    expect(confirmations()[0]!.body).toEqual({ method: 'POST', path: `/api/v1/harnesses/${getHarness().id}/deactivate`, body: null });
    expect(changes()[0]!.headers['x-cavelon-confirmation']).toMatch(/^cfm_/);
    expect(getHarness().status).toBe('inactive');
  } finally { await c.close(); }
});

it.each([false, undefined, 'yes', { approve: true }])('refuses a non-boolean-true UI result: %s', async answer => {
  const c = await connection();
  try {
    const preview = body(await c.bridge.call('deactivate', { harness: 'support' }));
    await c.bridge.call('deactivate', { harness: 'support', confirm: preview.confirm_token }, { ask: async () => answer });
    expect(confirmations()).toEqual([]);
    expect(changes()).toEqual([]);
    expect(getHarness().status).toBe('active');
  } finally { await c.close(); }
});

it('missing UI and a throwing UI handler do not authorize a change', async () => {
  const c = await connection();
  try {
    const preview = body(await c.bridge.call('deactivate', { harness: 'support' }));
    await c.bridge.call('deactivate', { harness: 'support', confirm: preview.confirm_token });
    await c.bridge.call('deactivate', { harness: 'support', confirm: preview.confirm_token }, { ask: async () => { throw new Error('UI unavailable'); } });
    expect(confirmations()).toEqual([]);
    expect(changes()).toEqual([]);
  } finally { await c.close(); }
});

it('cancellation dismisses the UI and a late yes cannot enter the next call', async () => {
  const c = await connection();
  const abort = new AbortController();
  let late: ((answer: boolean) => void) | undefined;
  let shown: (() => void) | undefined;
  const visible = new Promise<void>(resolve => shown = resolve);
  let dialogSignal: AbortSignal | undefined;
  try {
    const preview = body(await c.bridge.call('deactivate', { harness: 'support' }));
    const pending = c.bridge.call('deactivate', { harness: 'support', confirm: preview.confirm_token }, {
      signal: abort.signal,
      ask: async (_message: string, signal: AbortSignal) => { dialogSignal = signal; shown!(); return new Promise(resolve => late = resolve); },
    });
    const rejected = expect(pending).rejects.toThrow();
    await visible;
    abort.abort();
    await rejected;
    late!(true);
    await expect(c.bridge.call('deactivate', { harness: 'support', confirm: preview.confirm_token }, { ask: async () => true })).rejects.toThrow(/disconnected/);
    expect(dialogSignal?.aborted).toBe(true);
    expect(confirmations()).toEqual([]);
    expect(changes()).toEqual([]);
  } finally { await c.close(); }
});

it('a bounded timeout without an answer refuses and disconnects', async () => {
  const c = await connection(true, 100);
  try {
    const preview = body(await c.bridge.call('deactivate', { harness: 'support' }));
    await expect(c.bridge.call('deactivate', { harness: 'support', confirm: preview.confirm_token }, { ask: () => new Promise(() => {}) })).rejects.toThrow();
    expect(c.bridge.closed).toBe(true);
    expect(confirmations()).toEqual([]);
    expect(changes()).toEqual([]);
  } finally { await c.close(); }
});

it('concurrent requests cannot share a dialog or remember approval', async () => {
  const c = await connection();
  try {
    const preview = body(await c.bridge.call('deactivate', { harness: 'support' }));
    let asks = 0;
    const args = { harness: 'support', confirm: preview.confirm_token };
    const [first, second] = await Promise.all([
      c.bridge.call('deactivate', args, { ask: async () => { asks++; return false; } }),
      c.bridge.call('deactivate', args, { ask: async () => { asks++; return true; } }),
    ]);
    expect(body(first).error ?? body(first).exit_code).toBeDefined();
    expect(second.isError).not.toBe(true);
    expect(asks).toBe(2);
    expect(confirmations()).toHaveLength(1);
    expect(changes()).toHaveLength(1);
  } finally { await c.close(); }
});
