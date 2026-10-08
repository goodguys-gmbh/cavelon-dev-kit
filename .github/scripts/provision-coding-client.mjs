// Install only the pinned public client in an isolated qualification directory.
// Runtime fixtures then use loopback endpoints; provisioning needs network access.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile, chmod } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pins = JSON.parse(await readFile(path.join(repo, 'cli/test/fixtures/coding-client-runtimes.json'), 'utf8'));
// Assign only literal supported names: CLI input is never a path or command.
let client;
switch (process.argv[2]) {
  case 'cline': client = 'cline'; break;
  case 'kilo': client = 'kilo'; break;
  case 'goose': client = 'goose'; break;
  case 'omp': client = 'omp'; break;
  default: throw new Error('Choose cline, kilo, goose or omp.');
}
const pin = pins[client];
const runtime = path.resolve(process.env.CAVELON_CLIENT_RUNTIME ?? path.join(repo, '.wt/client-runtime', client));
const evidence = path.join(repo, '.wt/coding-client-runtime');
await mkdir(runtime, { recursive: true });
await mkdir(evidence, { recursive: true });

function execute(exe, args) {
  const result = spawnSync(exe, args, { cwd: runtime, encoding: 'utf8', timeout: 240_000, maxBuffer: 4_000_000 });
  if (result.error || result.status !== 0) throw new Error(`${exe} failed: ${result.error?.message ?? result.stderr ?? result.stdout}`);
  return result.stdout.trim();
}

let source, integrity;
if (pin.package) {
  // Use Node to invoke npm's CLI on Windows too; spawning npm.cmd needs a shell.
  const candidates = [process.env.npm_execpath, path.join(path.dirname(process.execPath), process.platform === 'win32' ? 'node_modules/npm/bin/npm-cli.js' : '../lib/node_modules/npm/bin/npm-cli.js')];
  for (const folder of (process.env.PATH ?? '').split(path.delimiter)) {
    if (process.platform === 'win32') candidates.push(path.join(folder, 'node_modules/npm/bin/npm-cli.js'));
    else if (existsSync(path.join(folder, 'npm'))) candidates.push(realpathSync(path.join(folder, 'npm')));
  }
  const npm = candidates.find(file => file && existsSync(file) && path.basename(file) === 'npm-cli.js');
  if (!npm) throw new Error('Cannot locate npm-cli.js; set npm_execpath explicitly.');
  execute(process.execPath, [npm, 'install', '--prefix', runtime, '--save-exact', '--no-audit', '--no-fund', `${pin.package}@${pin.version}`]);
  const installed = JSON.parse(await readFile(path.join(runtime, 'node_modules', pin.package, 'package.json'), 'utf8'));
  if (installed.version !== pin.version) throw new Error('Installed client version differs from the pin.');
  const lock = JSON.parse(await readFile(path.join(runtime, 'package-lock.json'), 'utf8'));
  const entry = lock.packages[`node_modules/${pin.package}`];
  source = entry.resolved;
  integrity = entry.integrity;
} else {
  const asset = pin.assets[`${process.platform}-${process.arch}`];
  if (!asset) throw new Error('No pinned Goose asset for this native platform.');
  source = `https://github.com/aaif-goose/goose/releases/download/v${pin.version}/${asset.name}`;
  const response = await fetch(source, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Goose asset returned ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  integrity = createHash('sha256').update(bytes).digest('hex');
  if (integrity !== asset.sha256) throw new Error('Goose release archive checksum does not match the pin.');
  const archive = path.join(runtime, asset.name);
  await writeFile(archive, bytes);
  const extracted = path.join(runtime, 'extracted');
  await mkdir(extracted, { recursive: true });
  // The Windows system tar is bsdtar and reads ZIP; Git Bash's tar does not.
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/tar.exe') : 'tar';
  execute(tar, ['-xf', archive, '-C', extracted]);
  const binaryName = process.platform === 'win32' ? 'goose.exe' : 'goose';
  async function findBinary(folder) {
    for (const item of await readdir(folder, { withFileTypes: true })) {
      const file = path.join(folder, item.name);
      if (item.isFile() && item.name === binaryName) return file;
      if (item.isDirectory()) { const found = await findBinary(file); if (found) return found; }
    }
  }
  const binary = await findBinary(extracted);
  if (!binary) throw new Error('Pinned release archive has no Goose CLI binary.');
  const installed = path.join(runtime, binaryName);
  await writeFile(installed, await readFile(binary));
  if (process.platform !== 'win32') await chmod(installed, 0o700);
  if (!execute(installed, ['--version']).includes(pin.version)) throw new Error('Goose binary version differs from the pin.');
}
await writeFile(path.join(evidence, `${client}-${process.platform}-${process.arch}-provision.json`), JSON.stringify({ client, version: pin.version, platform: `${process.platform}-${process.arch}`, source, integrity }, null, 2));
process.stdout.write(`Provisioned ${client} ${pin.version} for ${process.platform}/${process.arch}.\n`);
