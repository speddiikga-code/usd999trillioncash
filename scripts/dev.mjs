#!/usr/bin/env node
/**
 * `npm run dev` — one command for the whole local stack.
 *
 *  1. Creates .env from .env.example on first run, with freshly generated APP_SECRET and
 *     ENCRYPTION_KEY (and SANDBOX_DRIVER=process if Docker is not installed).
 *  2. Detects whether PostgreSQL (DATABASE_URL) is reachable.
 *       reachable   → API + standalone worker + dashboard
 *       unreachable → API with an embedded worker on embedded PGlite + dashboard
 *  3. Streams every process's output with a coloured prefix and shuts all of them down on Ctrl+C.
 *
 * `npm start` (--prod) runs the same processes without watch mode (build the dashboard first).
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const prod = process.argv.includes('--prod');
const envFile = path.join(root, '.env');
const c = { dim: (s) => `\x1b[2m${s}\x1b[0m`, yellow: (s) => `\x1b[33m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m` };

function dockerAvailable() {
  try {
    return spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 5000, windowsHide: true }).status === 0;
  } catch {
    return false;
  }
}

if (!existsSync(envFile)) {
  copyFileSync(path.join(root, '.env.example'), envFile);
  let text = readFileSync(envFile, 'utf8');
  text = text.replace(/^APP_SECRET=.*$/m, `APP_SECRET=${randomBytes(32).toString('base64url')}`);
  text = text.replace(/^ENCRYPTION_KEY=.*$/m, `ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`);
  if (!dockerAvailable()) {
    text = text.replace(/^SANDBOX_DRIVER=.*$/m, '# Docker not detected when this file was generated — using the weaker process sandbox for development.\nSANDBOX_DRIVER=process');
  }
  writeFileSync(envFile, text);
  console.log(c.green('✔ Created .env with generated APP_SECRET and ENCRYPTION_KEY (keep this file private).'));
}
process.loadEnvFile(envFile);

function reachable(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return resolve(false);
    }
    const sock = net.connect({ host: u.hostname || 'localhost', port: Number(u.port || 5432) });
    const done = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

const pgUp = process.env.DATABASE_URL ? await reachable(process.env.DATABASE_URL) : false;
const apiPort = process.env.API_PORT || '4000';

console.log('');
console.log(c.bold('ROOS — Revenue Opportunity Operating System'));
if (pgUp) {
  console.log(c.green(`✔ PostgreSQL reachable (${process.env.DATABASE_URL.replace(/\/\/[^@]*@/, '//***@')}) — starting API, worker and dashboard.`));
} else {
  console.log(c.yellow('⚠ PostgreSQL not reachable — using embedded PGlite (./data/pglite) with the worker inside the API process.'));
  console.log(c.dim('  For the full stack run `docker compose up -d` first (PostgreSQL + Redis).'));
}
console.log(c.dim(`  Dashboard  http://127.0.0.1:3000`));
console.log(c.dim(`  API        http://127.0.0.1:${apiPort}/api/health`));
console.log('');

const services = [
  { name: 'api', color: 36, cmd: `npm run ${prod ? 'start' : 'dev'} -w @roos/api` },
  ...(pgUp ? [{ name: 'worker', color: 35, cmd: `npm run ${prod ? 'start' : 'dev'} -w @roos/worker` }] : []),
  { name: 'dashboard', color: 33, cmd: `npm run ${prod ? 'start' : 'dev'} -w @roos/dashboard` },
];

const children = [];
let stopping = false;

function prefixStream(stream, name, color, target) {
  let buf = '';
  stream.on('data', (chunk) => {
    buf += chunk.toString();
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() ?? '';
    for (const line of lines) if (line.trim()) target.write(`\x1b[${color}m${name.padEnd(9)}\x1b[0m│ ${line}\n`);
  });
}

for (const s of services) {
  const env = { ...process.env, FORCE_COLOR: '1', NEXT_TELEMETRY_DISABLED: '1', ...(pgUp ? {} : { DATABASE_URL: '', EMBEDDED_WORKER: 'true' }) };
  if (s.name === 'dashboard') env.API_PORT = apiPort;
  const child = spawn(s.cmd, { cwd: root, env, shell: true, windowsHide: true });
  prefixStream(child.stdout, s.name, s.color, process.stdout);
  prefixStream(child.stderr, s.name, s.color, process.stderr);
  child.on('exit', (code) => {
    if (!stopping) {
      console.log(c.yellow(`${s.name} exited with code ${code} — stopping the rest.`));
      shutdown(code ?? 1);
    }
  });
  children.push(child);
}

function kill(child) {
  if (child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  else child.kill('SIGTERM');
}

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const ch of children) kill(ch);
  setTimeout(() => process.exit(code), 500);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
