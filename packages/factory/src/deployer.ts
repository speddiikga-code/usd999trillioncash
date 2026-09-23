import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { sleep } from '@roos/shared';

export interface LocalDeployment {
  id: string;
  driver: 'process' | 'docker';
  port: number;
  url: string;
  pid?: number;
  containerId?: string;
  logs: string[];
}

export function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

export async function allocatePort(start: number, end: number, taken: Set<number>): Promise<number> {
  for (let p = start; p <= end; p++) if (!taken.has(p) && (await portFree(p))) return p;
  throw new Error(`No free port in ${start}-${end}`);
}

async function waitHealthy(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  return false;
}

/**
 * Local preview deployments (localhost only). Production deployment is a separate,
 * approval-gated action. Process deployments run under Node's permission model.
 */
export class LocalDeployer {
  private running = new Map<string, { dep: LocalDeployment; child?: ChildProcess }>();

  constructor(private opts: { portStart: number; portEnd: number; image?: string }) {}

  list(): LocalDeployment[] {
    return [...this.running.values()].map((r) => r.dep);
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  async start(id: string, projectDir: string, dataDir: string, env: Record<string, string>, driver: 'process' | 'docker' = 'process'): Promise<LocalDeployment> {
    if (this.running.has(id)) return this.running.get(id)!.dep;
    const port = await allocatePort(this.opts.portStart, this.opts.portEnd, new Set(this.list().map((d) => d.port)));
    const url = `http://127.0.0.1:${port}`;
    mkdirSync(dataDir, { recursive: true });
    const logs: string[] = [];
    const log = (d: Buffer) => {
      logs.push(d.toString('utf8'));
      if (logs.length > 200) logs.shift();
    };

    if (driver === 'docker') {
      const name = `roos-dep-${id.replace(/[^a-z0-9]/gi, '').slice(-24).toLowerCase()}`;
      const args = [
        'run', '-d', '--rm', '--name', name,
        '-p', `127.0.0.1:${port}:3000`,
        '--memory=256m', '--cpus=0.5', '--pids-limit=128', '--read-only', '--tmpfs', '/tmp',
        '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user', '1000:1000',
        '-v', `${path.resolve(projectDir)}:/app:ro`, '-v', `${path.resolve(dataDir)}:/data`, '-w', '/app',
        '-e', 'HOST=0.0.0.0', '-e', 'PORT=3000', '-e', 'DATA_DIR=/data',
        ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v.replace('localhost', 'host.docker.internal')}`]),
        this.opts.image ?? 'node:24-alpine', 'node', 'server.js',
      ];
      const r = spawnSync('docker', args, { timeout: 60_000, windowsHide: true });
      if (r.status !== 0) throw new Error(`docker run failed: ${r.stderr?.toString().slice(0, 500)}`);
      const dep: LocalDeployment = { id, driver, port, url, containerId: r.stdout.toString().trim(), logs };
      this.running.set(id, { dep });
    } else {
      const dir = path.resolve(projectDir);
      const child = spawn(
        process.execPath,
        ['--permission', `--allow-fs-read=${dir}`, `--allow-fs-read=${path.resolve(dataDir)}`, `--allow-fs-write=${path.resolve(dataDir)}`, '--max-old-space-size=256', 'server.js'],
        { cwd: dir, env: { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '', HOST: '127.0.0.1', PORT: String(port), DATA_DIR: path.resolve(dataDir), NODE_ENV: 'production', ...env }, windowsHide: true },
      );
      child.stdout?.on('data', log);
      child.stderr?.on('data', log);
      child.on('exit', () => this.running.delete(id));
      const dep: LocalDeployment = { id, driver, port, url, pid: child.pid, logs };
      this.running.set(id, { dep, child });
    }

    if (!(await waitHealthy(url, 15_000))) {
      const logText = logs.join('').slice(-1000);
      await this.stop(id);
      throw new Error(`Deployment did not become healthy. Logs: ${logText}`);
    }
    return this.running.get(id)!.dep;
  }

  async stop(id: string): Promise<boolean> {
    const r = this.running.get(id);
    if (!r) return false;
    if (r.child) r.child.kill();
    if (r.dep.containerId) spawnSync('docker', ['stop', r.dep.containerId], { timeout: 30_000, windowsHide: true });
    this.running.delete(id);
    return true;
  }

  async stopAll() {
    for (const id of [...this.running.keys()]) await this.stop(id);
  }
}
