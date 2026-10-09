// The released host owns every answer; this wrapper never supplies one.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import process from 'node:process';
import { setTimeout } from 'node:timers';

export default async function qualification(api) {
  const directory = process.env.CAVELON_APPROVAL_RUN, tools = new Map();
  let ended = false;
  const write = async (name, value) => {
    const file = path.join(directory, name), temporary = file + '.tmp-' + process.pid;
    await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await fs.rename(temporary, file);
  };
  const proxy = new Proxy(api, { get(target, key) {
    if (key === 'registerTool') return tool => { tools.set(tool.name, tool); return target.registerTool(tool); };
    if (key === 'on') return (event, handler) => target.on(event, async (ev, ctx) => {
      await handler(ev, ctx);
      if (event === 'session_start') {
        await write('native-ready.json', { tools: [...tools.keys()], hasUI: ctx.hasUI, mode: ctx.mode });
        setTimeout(() => { void drive(ctx).catch(async e => { await write('driver-failure.json', { failure: String(e) }); }); }, 100);
      }
    });
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  await (await import(pathToFileURL(process.env.CAVELON_APPROVAL_ADAPTER).href)).default(proxy);
  api.on('session_shutdown', () => { ended = true; });
  async function drive(ctx) {
    const completed = new Set();
    while (!ended) {
      let command;
      try { command = JSON.parse(await fs.readFile(path.join(directory, 'native-case.json'), 'utf8')); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (command && ['decline', 'approve'].includes(command.id) && !completed.has(command.id)) {
        completed.add(command.id);
        const dialogs = [];
        const context = new Proxy(ctx, { get(target, key) {
          if (key === 'ui') return new Proxy(target.ui, { get(ui, property) {
            if (property === 'confirm') return async (title, message, options) => {
              const answer = await ui.confirm(title, message, options);
              dialogs.push({ title, answer, message_sha256: createHash('sha256').update(message).digest('hex') });
              return answer;
            };
            const value = Reflect.get(ui, property); return typeof value === 'function' ? value.bind(ui) : value;
          } });
          const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
        } });
        try {
          const invoke = async args => {
            const result = await tools.get('mcp__cavelon__apply').execute('synthetic-qualification-' + command.id, args, new globalThis.AbortController().signal, undefined, context);
            return JSON.parse(result.content[0].text);
          };
          const selected = { solution_dir: 'solutions/review', env: 'test' };
          const preview = await invoke({ ...selected, mode: 'replace' });
          if (!preview.preview_id || !preview.show_to_person) throw new Error('Missing guarded child preview.');
          const result = await invoke({ ...selected, confirm: preview.preview_id });
          await write(command.id + '.json', { code: result.error?.code, applied: result.applied === true, dialogs });
        } catch (e) { await write(command.id + '.json', { failure: String(e), dialogs }); }
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}
