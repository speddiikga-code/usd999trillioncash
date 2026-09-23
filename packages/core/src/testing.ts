import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDb } from '@roos/database';
import type { SafeResponse } from '@roos/security';
import { loadConfig, nullLogger, type AppConfig } from '@roos/shared';
import { Core, type CoreOptions } from './core';

/** Build a fake HTTP fetcher that serves canned responses by URL substring (for connector tests). */
export function fixtureFetcher(routes: Record<string, unknown | ((url: string) => unknown)>, calls: string[] = []) {
  return async (url: string): Promise<SafeResponse> => {
    calls.push(url);
    const key = Object.keys(routes).find((k) => url.includes(k));
    const raw = key === undefined ? undefined : routes[key];
    const body = typeof raw === 'function' ? (raw as (u: string) => unknown)(url) : raw;
    const text = body === undefined ? '{"error":"no fixture"}' : typeof body === 'string' ? body : JSON.stringify(body);
    return {
      status: body === undefined ? 404 : 200,
      ok: body !== undefined,
      url,
      headers: { 'content-type': typeof body === 'string' ? 'text/html' : 'application/json' },
      bytes: Buffer.from(text),
      text: () => text,
      json: <T>() => JSON.parse(text) as T,
    };
  };
}

export function testConfig(env: Record<string, string> = {}): AppConfig {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'roos-test-'));
  return loadConfig({
    NODE_ENV: 'test',
    APP_SECRET: 'test-app-secret-test-app-secret-0123456789',
    ENCRYPTION_KEY: 'test-encryption-key-test-encryption-key-01',
    SANDBOX_DRIVER: 'process',
    PROJECTS_DIR: path.join(dir, 'projects'),
    DATA_DIR: dir,
    EMAIL_DRIVER: 'outbox',
    API_PUBLIC_URL: 'http://127.0.0.1:4999',
    ALLOW_REGISTRATION: 'true',
    AI_PROVIDER_ORDER: 'mock',
    DEPLOY_PORT_START: '5150',
    DEPLOY_PORT_END: '5189',
    ...env,
  });
}

/** A fully initialised Core on an in-memory PGlite database. */
export async function createTestCore(opts: Partial<CoreOptions> & { env?: Record<string, string> } = {}) {
  const db = await createTestDb();
  const cfg = opts.cfg ?? testConfig(opts.env);
  const core = new Core({ db, cfg, logger: nullLogger, ...opts });
  await core.init();
  return core;
}
