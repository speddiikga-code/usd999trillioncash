import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Isolated execution of generated code.
 *
 *  docker  — container with no network, read-only root FS and read-only project mount, tmpfs
 *            scratch space, CPU / memory / PID limits, all capabilities dropped, non-root user,
 *            no-new-privileges, hard timeout. Recommended; required in production.
 *  process — development fallback: Node's permission model (--permission) restricts filesystem
 *            reads to the project, writes to a temp dir, and forbids child processes, workers and
 *            native addons; env is stripped; hard timeout; heap cap. It does NOT block network
 *            access and is weaker than a container — never allowed when NODE_ENV=production.
 */
export interface SandboxLimits {
  timeoutMs: number;
  memoryMb: number;
  cpus: number;
  network: 'none' | 'bridge';
}

export interface SandboxResult {
  driver: 'docker' | 'process';
  status: 'passed' | 'failed' | 'timeout' | 'error' | 'skipped';
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  command: string;
  limits: SandboxLimits;
  isolation: string[];
}

export interface SandboxDriver {
  readonly name: 'docker' | 'process';
  available(): Promise<boolean>;
  runTests(projectDir: string, limits: SandboxLimits): Promise<SandboxResult>;
}

const MAX_OUTPUT = 64 * 1024;
const TEST_FILE = 'test/server.test.js';

/**
 * Under Node's permission model the test runner must not spawn per-file child processes (that would
 * need --allow-child-process), so it runs in-process. The flag was renamed in Node 23.
 */
export function inProcessTestFlag(nodeVersion = process.versions.node): string {
  return Number(nodeVersion.split('.')[0]) >= 23 ? '--test-isolation=none' : '--experimental-test-isolation=none';
}

/** Remove a directory, retrying while Windows releases handles held by a just-exited child. */
export function removeDir(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    /* best effort: a leftover temp directory must not fail the run */
  }
}

function collect(child: ReturnType<typeof spawn>, timeoutMs: number, onTimeout: () => void): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      onTimeout();
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += d.toString('utf8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += d.toString('utf8');
    });
    child.on('error', (e) => {
      stderr += `\n${e.message}`;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: stdout.slice(0, MAX_OUTPUT), stderr: stderr.slice(0, MAX_OUTPUT), timedOut });
    });
  });
}

export class DockerSandbox implements SandboxDriver {
  readonly name = 'docker' as const;
  constructor(private image = 'node:24-alpine') {}

  async available(): Promise<boolean> {
    try {
      const r = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 5000, windowsHide: true });
      return r.status === 0;
    } catch {
      return false;
    }
  }

  async runTests(projectDir: string, limits: SandboxLimits): Promise<SandboxResult> {
    const name = `roos-sbx-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const args = [
      'run', '--rm', '--name', name,
      `--network=${limits.network}`,
      `--memory=${limits.memoryMb}m`, `--memory-swap=${limits.memoryMb}m`,
      `--cpus=${limits.cpus}`, '--pids-limit=128',
      '--read-only', '--tmpfs', '/tmp:rw,size=64m,mode=1777',
      '--cap-drop=ALL', '--security-opt=no-new-privileges',
      '--user', '1000:1000',
      '-v', `${path.resolve(projectDir)}:/app:ro`, '-w', '/app',
      '-e', 'DATA_DIR=/tmp', '-e', 'NODE_ENV=test',
      // The container is the isolation boundary, so the default runner mode works on any Node version.
      this.image, 'node', '--test', TEST_FILE,
    ];
    const started = Date.now();
    const child = spawn('docker', args, { windowsHide: true });
    const r = await collect(child, limits.timeoutMs, () => spawnSync('docker', ['kill', name], { timeout: 10_000, windowsHide: true }));
    return {
      driver: 'docker',
      status: r.timedOut ? 'timeout' : r.code === 0 ? 'passed' : 'failed',
      exitCode: r.code,
      stdout: r.stdout,
      stderr: r.stderr,
      durationMs: Date.now() - started,
      command: `docker ${args.join(' ')}`,
      limits,
      isolation: ['container', `network=${limits.network}`, 'read-only rootfs', 'read-only project mount', `memory=${limits.memoryMb}MB`, `cpus=${limits.cpus}`, 'pids≤128', 'cap-drop ALL', 'non-root', 'no-new-privileges'],
    };
  }
}

export class ProcessSandbox implements SandboxDriver {
  readonly name = 'process' as const;
  async available(): Promise<boolean> {
    return true;
  }

  async runTests(projectDir: string, limits: SandboxLimits): Promise<SandboxResult> {
    const dir = path.resolve(projectDir);
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'roos-sbx-'));
    mkdirSync(scratch, { recursive: true });
    const args = [
      '--permission',
      `--allow-fs-read=${dir}`,
      `--allow-fs-read=${scratch}`,
      `--allow-fs-write=${scratch}`,
      `--max-old-space-size=${Math.max(64, limits.memoryMb)}`,
      '--test',
      inProcessTestFlag(),
      TEST_FILE,
    ];
    const env: NodeJS.ProcessEnv = { DATA_DIR: scratch, NODE_ENV: 'test', PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '', TEMP: scratch, TMP: scratch };
    const started = Date.now();
    const child = spawn(process.execPath, args, { cwd: dir, env, windowsHide: true });
    const r = await collect(child, limits.timeoutMs, () => child.kill('SIGKILL'));
    removeDir(scratch);
    return {
      driver: 'process',
      status: r.timedOut ? 'timeout' : r.code === 0 ? 'passed' : 'failed',
      exitCode: r.code,
      stdout: r.stdout,
      stderr: r.stderr,
      durationMs: Date.now() - started,
      command: `node ${args.join(' ')}`,
      limits,
      isolation: ['node --permission', 'fs read: project only', 'fs write: temp dir only', 'no child processes / workers / addons', 'stripped env', `heap≤${limits.memoryMb}MB`, 'timeout', 'NETWORK NOT RESTRICTED (use docker for full isolation)'],
    };
  }
}

export async function pickSandbox(driver: 'docker' | 'process' | 'disabled', image?: string): Promise<SandboxDriver | null> {
  if (driver === 'disabled') return null;
  if (driver === 'docker') {
    const d = new DockerSandbox(image);
    return (await d.available()) ? d : null;
  }
  return new ProcessSandbox();
}
