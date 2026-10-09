// Build locally so source-relative contract snapshots stay portable between hosts.
import { build } from 'esbuild';
import { createRequire, isBuiltin } from 'node:module';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import { spawn } from 'node:child_process';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(repo, '.wt/approval-tooling');
await mkdir(out, { recursive: true });
const bundle = path.join(out, 'supervisor-' + process.pid + '.mjs');
const require = createRequire(new URL('../package.json', import.meta.url));
await build({
  entryPoints: [path.join(repo, 'cli/test/fixtures/approval-supervisor.ts')], outfile: bundle,
  bundle: true, platform: 'node', format: 'esm', packages: 'external',
  plugins: [{ name: 'qualification-source-locations', setup(builder) {
    builder.onResolve({ filter: /^[^./]/ }, args => isBuiltin(args.path) ? { path: args.path, external: true }
      : path.isAbsolute(args.path) ? undefined : { path: pathToFileURL(require.resolve(args.path)).href, external: true });
    builder.onLoad({ filter: /\.[cm]?[jt]s$/ }, async args => ({
      contents: (await readFile(args.path, 'utf8')).replaceAll('import.meta.url', JSON.stringify(pathToFileURL(args.path).href)),
      loader: args.path.endsWith('.ts') ? 'ts' : 'js',
    }));
  } }],
});
const child = spawn(process.execPath, [bundle, ...process.argv.slice(2)], { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.once('error', error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
