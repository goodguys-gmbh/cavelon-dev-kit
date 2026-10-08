import { it, expect } from 'vitest';
import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { AGENT_VARIABLES } from '../src/agent-env.js';
import { parse, stringify } from 'yaml';
import { startFakeServer } from './fake-server.js';
import { login, sandbox } from './helpers.js';
const repo = path.resolve('..'), output = path.join(repo, '.wt/coding-client-runtime');
const name = process.env.CAVELON_QUALIFY_CLIENT ?? '';
const candidate = process.env.CAVELON_EXECUTABLE ?? '';
const runtime = process.env.CAVELON_CLIENT_RUNTIME ?? path.join(repo, '.wt/client-runtime');
const clients = JSON.parse(readFileSync(path.join(repo, 'cli/test/fixtures/coding-client-runtimes.json'), 'utf8'));
const pin = clients[name];
interface ClientResult {
    code: number | null;
    out: string;
    err: string;
}
async function run(exe: string, args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<ClientResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(exe, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
        let out = '', err = '', timedOut = false;
        // These are only this invocation's processes. A timed-out client must not
        // leave its backend or Cavelon MCP child running after the fixture closes.
        const stop = () => {
            if (!child.pid)
                return;
            if (process.platform === 'win32') {
                spawnSync(path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000 });
            }
            else {
                try {
                    process.kill(-child.pid, 'SIGKILL');
                }
                catch { /* Process group already exited. */ }
            }
        };
        const timer = setTimeout(() => { timedOut = true; stop(); }, 90000);
        child.stdout.on('data', b => { out = (out + b).slice(-2000000); });
        child.stderr.on('data', b => { err = (err + b).slice(-2000000); });
        child.once('error', error => { clearTimeout(timer); stop(); reject(error); });
        child.once('close', code => {
            clearTimeout(timer);
            if (process.platform !== 'win32')
                stop();
            if (timedOut)
                reject(new Error('Bounded fixture timeout: ' + JSON.stringify({ args, out, err })));
            else
                resolve({ code, out, err });
        });
    });
}
// Opt-in: the ordinary unit suite neither installs a coding client nor calls a provider.
it.skipIf(!name || !candidate)('runs two native released-client workflows using only scripted loopback fixtures', async () => {
    await fs.mkdir(output, { recursive: true });
    expect(pin).toBeTruthy();
    expect(candidate).toBeTruthy();
    const sb = sandbox(), instance = await startFakeServer(), requests: any[] = [];
    let step = 0, root = '', runId = '', improved = false, providerFailure = '';
    const model = http.createServer(async (req, res) => {
        try {
            let raw = '';
            for await (const b of req)
                raw += b;
            const body = raw ? JSON.parse(raw) : {};
            requests.push({ url: req.url, body });
            if (req.method === 'GET') {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ object: 'list', data: [{ id: 'synthetic-fixture', object: 'model', created: 1, owned_by: 'fixture' }] }));
                return;
            }
            const names = (body.tools ?? []).map((t: any) => t.function.name);
            const previous = (body.messages ?? []).filter((m: any) => m.role === 'tool').map((m: any) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
            const preview = [...previous.matchAll(/pv_[a-f0-9]+/g)].at(-1)?.[0];
            if (step === 6 && !improved) {
                const file = path.join(root, 'solutions/review/package/agents.yaml');
                const agents = parse(await fs.readFile(file, 'utf8')) as any[];
                agents[0].instructions += ' One bounded prompt improvement after reading the synthetic trace.';
                await fs.writeFile(file, stringify(agents));
                improved = true;
            }
            if (step % 6 === 4)
                runId = [...instance.state.operations.keys()].at(-1)!;
            const selected = { solution_dir: 'solutions/review' };
            const actions: any[] = [['validate', selected], ['apply', { ...selected, mode: 'overwrite', env: 'test' }], ['apply', { ...selected, env: 'test', confirm: preview }], ['test_run', { ...selected, suite: ['smoke'] }], ['operation_status', { ...selected, operation: [runId], timeout: '5s' }], ['trace', { ...selected, run: runId }]];
            const planned = names.length && step < 12 ? actions[step++ % 6] : undefined;
            if (planned && !names.includes(pin.tool_prefix + planned[0]))
                throw new Error('Missing workflow tool ' + planned[0]);
            const answer = planned ? { role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'synthetic_' + requests.length, type: 'function', function: { name: pin.tool_prefix + planned[0], arguments: JSON.stringify(planned[1]) } }] } : { role: 'assistant', content: 'Synthetic qualification complete.' };
            const chunk = { id: 'synthetic', object: 'chat.completion.chunk', created: 1, model: 'synthetic-fixture', choices: [{ index: 0, delta: answer, finish_reason: planned ? 'tool_calls' : 'stop' }] };
            if (body.stream) {
                res.setHeader('Content-Type', 'text/event-stream');
                res.end('data: ' + JSON.stringify(chunk) + '\n\ndata: [DONE]\n\n');
            }
            else {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ ...chunk, object: 'chat.completion', choices: [{ index: 0, message: answer, finish_reason: planned ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
            }
        }
        catch (e: any) {
            providerFailure = e.message;
            res.statusCode = 500;
            res.end(JSON.stringify({ error: { message: e.message } }));
        }
    });
    await new Promise<void>(r => model.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(model.address() as any).port}/v1`;
    const evidence = path.join(output, name + '-' + process.platform + '-' + process.arch);
    try {
        const tenant = instance.addTenant('workflow', 'Synthetic workflow');
        await login(sb, instance.url, instance.addToken({ kind: 'pat', tenantIds: [tenant], defaultTenant: tenant }));
        root = path.join(sb.home, 'multi solution root');
        await fs.mkdir(root);
        await fs.writeFile(path.join(root, 'cavelon.yaml'), `instance: ${instance.url}\ntenant: ${tenant}\n`);
        const bin = path.join(sb.home, 'bin');
        await fs.mkdir(bin);
        const installed = path.join(bin, process.platform === 'win32' ? 'cavelon.exe' : 'cavelon');
        await fs.copyFile(candidate, installed);
        if (process.platform !== 'win32')
            await fs.chmod(installed, 0o700);
        const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('CAVELON_') && !AGENT_VARIABLES.some(({ variable }) => variable === key)));
        const env: any = { ...inherited, ...sb.env, USERPROFILE: sb.home, APPDATA: path.join(sb.home, 'AppData/Roaming'), LOCALAPPDATA: path.join(sb.home, 'AppData/Local'), PATH: bin + path.delimiter + process.env.PATH, TERM: 'xterm-256color', CAVELON_NO_UPDATE_CHECK: '1', CAVELON_AGENT: '0', XDG_CONFIG_HOME: path.join(sb.home, 'xdg'), XDG_DATA_HOME: path.join(sb.home, 'data'), XDG_STATE_HOME: path.join(sb.home, 'state'), XDG_CACHE_HOME: path.join(sb.home, 'cache'), CLINE_DIR: path.join(sb.home, 'cline'), CLINE_SESSION_BACKEND_MODE: 'local', CLINE_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1', KILO_DISABLE_MODELS_FETCH: '1', KILO_DISABLE_AUTOUPDATE: '1', KILO_DISABLE_DEFAULT_PLUGINS: '1', KILO_DISABLE_LSP_DOWNLOAD: '1', KILO_TEST_MANAGED_CONFIG_DIR: path.join(sb.home, 'managed'), GOOSE_PATH_ROOT: path.join(sb.home, 'goose'), GOOSE_DISABLE_KEYRING: '1', GOOSE_TELEMETRY_ENABLED: 'false', GOOSE_PROVIDER: 'openai', GOOSE_MODEL: 'synthetic-fixture', OPENAI_BASE_URL: url, OPENAI_API_KEY: 'synthetic-fixture-placeholder', GOOSE_MODE: 'auto', GOOSE_MAX_TURNS: '18', PI_CODING_AGENT_DIR: path.join(sb.home, 'omp'), OMP_PROFILE: 'default' };
        delete env.PWD;
        delete env.OLDPWD;
        delete env.INIT_CWD;
        const cav = async (args: string[], cwd = root) => run(candidate, args, env, cwd);
        for (const slug of ['review', 'assistant']) {
            const cwd = path.join(root, 'solutions', slug);
            await fs.mkdir(cwd, { recursive: true });
            for (const args of [['init', '--instance', instance.url, '--tenant', tenant, '--harness', slug], ['pull']]) {
                const result = await cav(args, cwd);
                expect(result.code, result.out + result.err).toBe(0);
            }
            const file = path.join(cwd, 'package/agents.yaml');
            const agents = parse(await fs.readFile(file, 'utf8')) as any[];
            agents[0].instructions = 'Synthetic draft for the packaged workflow qualification.';
            await fs.writeFile(file, stringify(agents));
            instance.state.configs.clear();
        }
        const setup = await cav(['setup', '--agents', name, '--yes', '--json']);
        expect(setup.code, setup.out + setup.err).toBe(0);
        const suiteId = '5a17e000-0000-4000-8000-0000000000f1';
        instance.state.suites.push({ id: suiteId, tenant_id: tenant, name: 'smoke', harness_id: instance.state.harnesses.find(h => h.slug === 'review')!.id, archived_at: null });
        let exe: string, args: string[];
        const preargs: string[] = [];
        if (name === 'cline') {
            await fs.writeFile(path.join(env.CLINE_DIR, 'data/settings/providers.json'), JSON.stringify({ version: 1, lastUsedProvider: 'openai-compatible', modes: {}, providers: { 'openai-compatible': { settings: { provider: 'openai-compatible', model: 'synthetic-fixture', protocol: 'openai-chat', client: 'openai-compatible', apiKey: 'synthetic-fixture-placeholder', baseUrl: url, modelCatalog: { loadLatestOnInit: false, includeClineCloudModels: false, loadPrivateOnAuth: false } }, updatedAt: new Date().toISOString(), tokenSource: 'manual' } } }));
            exe = process.execPath;
            preargs.push(path.join(runtime, 'node_modules/cline/bin/cline'));
            args = ['--json', '--provider', 'openai-compatible', '--model', 'synthetic-fixture', '--timeout', '75', 'Synthetic scripted local workflow'];
        }
        else if (name === 'kilo') {
            const file = path.join(env.XDG_CONFIG_HOME, 'kilo/kilo.json');
            const config = JSON.parse(await fs.readFile(file, 'utf8'));
            config.provider = { fixture: { npm: '@ai-sdk/openai-compatible', name: 'Synthetic local fixture', options: { baseURL: url, apiKey: 'synthetic-fixture-placeholder' }, models: { 'synthetic-fixture': { name: 'Synthetic fixture', limit: { context: 65536, output: 8192 } } } } };
            config.model = 'fixture/synthetic-fixture';
            config.small_model = config.model;
            config.permission = { '*': 'allow' };
            await fs.writeFile(file, JSON.stringify(config));
            exe = process.execPath;
            preargs.push(path.join(runtime, 'node_modules/@kilocode/cli/bin/kilo'));
            args = ['run', '--format', 'json', '--model', config.model, 'Synthetic scripted local workflow'];
        }
        else if (name === 'goose') {
            exe = process.env.CAVELON_CODING_CLIENT_BINARY ?? path.join(runtime, process.platform === 'win32' ? 'goose.exe' : 'goose');
            args = ['run', '--text', 'Synthetic scripted local workflow', '--debug', '--output-format', 'json', '--max-turns', '18'];
        }
        else {
            await fs.writeFile(path.join(env.PI_CODING_AGENT_DIR, 'models.yml'), JSON.stringify({ providers: { fixture: { baseUrl: url, api: 'openai-completions', apiKey: 'synthetic-fixture-placeholder', models: [{ id: 'synthetic-fixture', name: 'Synthetic fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 4096 }] } } }));
            exe = process.env.CAVELON_BUN ?? 'bun';
            args = [path.join(runtime, 'node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js'), '--print', '--mode', 'json', '--provider', 'fixture', '--model', 'synthetic-fixture', '--no-session', '--no-title', '--no-lsp', '--no-pty', '--approval-mode', 'yolo', 'Synthetic scripted local workflow'];
        }
        const versionArgs = name === 'omp' ? [args[0]!, '--version'] : [...preargs, '--version'];
        const versionResult = await run(exe, versionArgs, env, root);
        expect(versionResult.code, versionResult.out + versionResult.err).toBe(0);
        expect(versionResult.out).toContain(pin.version);
        if (pin.bun) {
            const bunVersion = await run(exe, ['--version'], env, root);
            expect(bunVersion.code, bunVersion.err).toBe(0);
            expect(bunVersion.out.trim()).toBe(pin.bun);
        }
        env.CAVELON_AGENT = '1';
        instance.state.requests.length = 0;
        const result = await run(exe, [...preargs, ...args], env, root);
        await fs.writeFile(evidence + '-client.json', JSON.stringify(result));
        await fs.writeFile(evidence + '-requests.json', JSON.stringify(requests, null, 2));
        expect(providerFailure).toBe('');
        expect(result.code, result.out + result.err).toBe(0);
        expect(step).toBe(12);
        expect(improved).toBe(true);
        const nonces = instance.state.requests.filter(r => r.path === '/api/v1/confirmations');
        const imports = instance.state.requests.filter(r => r.method === 'POST' && r.path === '/api/v1/agent-graph/import');
        expect(nonces).toHaveLength(0);
        expect(imports).toHaveLength(2);
        expect([...instance.state.operations.values()]).toHaveLength(2);
        const toolResults = new Map<string, any>();
        for (const request of requests)
            for (const message of request.body.messages ?? []) {
                if (message.role !== 'tool')
                    continue;
                let value = typeof message.content === 'string' ? JSON.parse(message.content) : message.content;
                if (value.content?.[0]?.text)
                    value = JSON.parse(value.content[0].text);
                toolResults.set(message.tool_call_id, value);
            }
        const values = [...toolResults.values()];
        expect(values.map(v => v.error?.code).filter(Boolean)).toEqual([]);
        expect(values.filter(v => v.valid === true)).toHaveLength(2);
        expect(values.filter(v => v.applied === true)).toHaveLength(2);
        expect(values.filter(v => v.settled === true)).toHaveLength(2);
        expect(values.filter(v => v.kind === 'test' && v.results?.items?.length)).toHaveLength(2);
        expect(JSON.stringify(imports[1]?.body)).toContain('One bounded prompt improvement');
        await fs.writeFile(evidence + '-evidence.json', JSON.stringify({ client: name, version: pin.version, candidate, platform: process.platform + '-' + process.arch, standalone_consumer: true, generated_setup: true, multi_solution: true, validate: 2, previews: 2, ordinary_draft_imports: 2, suite_runs: 2, status: 2, traces: 2, bounded_improvement: true, guarded_changes: 0, confirmations: 0, actual_person_ui: false, scripted_loopback_requests: requests.length, real_model_calls: 0, production_actions: 0, completed_at: new Date().toISOString() }, null, 2));
    }
    finally {
        await new Promise<void>(r => model.close(() => r()));
        await instance.close();
        sb.cleanup();
    }
}, 120000);
