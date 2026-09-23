import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Centralised, validated runtime configuration. All secrets come from the environment
 * (or from the encrypted `secrets` table for per-organisation provider keys) — never from code.
 */
export interface AppConfig {
  env: 'development' | 'test' | 'production';
  isProd: boolean;
  rootDir: string;
  appUrl: string;
  api: {
    host: string;
    port: number;
    publicUrl: string;
    trustProxy: boolean;
    rateLimitPerMin: number;
    authRateLimitPerMin: number;
    trackRateLimitPerMin: number;
    bodyLimitBytes: number;
  };
  db: {
    url?: string;
    pgliteDir: string;
    /** When DATABASE_URL is unset/unreachable in development, fall back to embedded PGlite. */
    fallback: 'pglite' | 'none';
    poolMax: number;
  };
  redisUrl?: string;
  secrets: {
    appSecret: string;
    encryptionKey: Buffer;
    previousEncryptionKey?: Buffer;
    /** true when secrets were generated ephemerally (dev/test only). */
    ephemeral: boolean;
  };
  auth: {
    allowRegistration: boolean;
    sessionTtlHours: number;
    cookieSecure: boolean;
    /** Read-only guest sessions scoped to the synthetic demo workspace (default: on in development only). */
    demoGuestLogin: boolean;
  };
  worker: {
    embedded: boolean;
    concurrency: number;
    pollMs: number;
    roles: string[];
  };
  ai: {
    openaiKey?: string;
    anthropicKey?: string;
    googleKey?: string;
    ollamaBaseUrl?: string;
    providerOrder: string[];
    dailyBudgetUsd: number;
    maxCostPerTaskUsd: number;
    requestTimeoutMs: number;
  };
  connectors: {
    userAgent: string;
    timeoutMs: number;
    maxBytes: number;
    githubToken?: string;
    stackexchangeKey?: string;
    braveSearchKey?: string;
    secUserAgent?: string;
    allowPrivateNetworks: boolean;
  };
  billing: {
    stripeSecretKey?: string;
    stripeWebhookSecret?: string;
  };
  email: {
    driver: 'outbox' | 'resend';
    resendKey?: string;
    from?: string;
    postalAddress?: string;
    dailyCap: number;
  };
  sandbox: {
    driver: 'docker' | 'process' | 'disabled';
    image: string;
    timeoutMs: number;
    memoryMb: number;
    cpus: number;
    projectsDir: string;
    deployPortStart: number;
    deployPortEnd: number;
  };
  scheduler: {
    discoveryIntervalMin: number;
    experimentEvalIntervalMin: number;
    dailyReportHourUtc: number;
  };
  observability: {
    logLevel: 'debug' | 'info' | 'warn' | 'error';
    errorWebhookUrl?: string;
  };
}

function str(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const v = env[name];
  return v === undefined || v.trim() === '' ? undefined : v.trim();
}
function num(name: string, env: NodeJS.ProcessEnv, dflt: number): number {
  const v = str(name, env);
  if (v === undefined) return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Environment variable ${name} must be a number (got "${v}")`);
  return n;
}
function bool(name: string, env: NodeJS.ProcessEnv, dflt: boolean): boolean {
  const v = str(name, env);
  if (v === undefined) return dflt;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

/** Accepts a base64 32-byte key, a 64-char hex key, or any passphrase ≥ 32 chars (hashed with SHA-256). */
export function deriveKey(raw: string): Buffer {
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  const b64 = Buffer.from(raw, 'base64');
  if (b64.length === 32 && /^[A-Za-z0-9+/=_-]+$/.test(raw)) return b64;
  if (raw.length < 32) throw new Error('ENCRYPTION_KEY must be 32 bytes (base64/hex) or a passphrase of at least 32 characters');
  return createHash('sha256').update(raw).digest();
}

/** Walk up from cwd to find the monorepo root (the directory with the root package.json workspaces). */
export function findRootDir(start = process.cwd()): string {
  let dir = path.resolve(start);
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, 'packages')) && existsSync(path.join(dir, 'apps')) && existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(start);
}

/** Load `.env` from the repo root into process.env (does not override existing variables). */
export function loadEnvFile(rootDir = findRootDir()): string | null {
  const file = path.join(rootDir, '.env');
  if (existsSync(file)) {
    try {
      process.loadEnvFile(file);
      return file;
    } catch {
      return null;
    }
  }
  return null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = (str('NODE_ENV', env) ?? 'development') as AppConfig['env'];
  const isProd = nodeEnv === 'production';
  const rootDir = findRootDir();

  let appSecret = str('APP_SECRET', env);
  let encRaw = str('ENCRYPTION_KEY', env);
  let ephemeral = false;
  if (!appSecret || !encRaw) {
    if (isProd) throw new Error('APP_SECRET and ENCRYPTION_KEY are required in production. See ENVIRONMENT.md.');
    ephemeral = true;
    appSecret ??= randomBytes(32).toString('base64url');
    encRaw ??= randomBytes(32).toString('base64');
  }
  if (isProd && appSecret.length < 32) throw new Error('APP_SECRET must be at least 32 characters in production');
  const prevRaw = str('ENCRYPTION_KEY_PREVIOUS', env);

  const port = num('API_PORT', env, 4000);
  const host = str('API_HOST', env) ?? (isProd ? '0.0.0.0' : '127.0.0.1');
  const dataDir = path.resolve(rootDir, str('DATA_DIR', env) ?? 'data');

  const sandboxDriver = (str('SANDBOX_DRIVER', env) ?? 'docker') as AppConfig['sandbox']['driver'];
  if (!['docker', 'process', 'disabled'].includes(sandboxDriver)) throw new Error('SANDBOX_DRIVER must be docker | process | disabled');
  if (isProd && sandboxDriver === 'process') throw new Error('SANDBOX_DRIVER=process is not permitted in production (weaker isolation). Use docker.');

  const emailDriver = (str('EMAIL_DRIVER', env) ?? 'outbox') as AppConfig['email']['driver'];

  return {
    env: nodeEnv,
    isProd,
    rootDir,
    appUrl: str('APP_URL', env) ?? 'http://localhost:3000',
    api: {
      host,
      port,
      publicUrl: str('API_PUBLIC_URL', env) ?? `http://localhost:${port}`,
      trustProxy: bool('TRUST_PROXY', env, false),
      rateLimitPerMin: num('RATE_LIMIT_PER_MIN', env, 300),
      authRateLimitPerMin: num('AUTH_RATE_LIMIT_PER_MIN', env, 10),
      trackRateLimitPerMin: num('TRACK_RATE_LIMIT_PER_MIN', env, 600),
      bodyLimitBytes: num('API_BODY_LIMIT_BYTES', env, 2 * 1024 * 1024),
    },
    db: {
      url: str('DATABASE_URL', env),
      pgliteDir: path.resolve(rootDir, str('PGLITE_DATA_DIR', env) ?? path.join(dataDir, 'pglite')),
      fallback: (str('DB_FALLBACK', env) ?? (isProd ? 'none' : 'pglite')) as 'pglite' | 'none',
      poolMax: num('DB_POOL_MAX', env, 10),
    },
    redisUrl: str('REDIS_URL', env),
    secrets: {
      appSecret,
      encryptionKey: deriveKey(encRaw),
      previousEncryptionKey: prevRaw ? deriveKey(prevRaw) : undefined,
      ephemeral,
    },
    auth: {
      allowRegistration: bool('ALLOW_REGISTRATION', env, !isProd),
      sessionTtlHours: num('SESSION_TTL_HOURS', env, 24 * 7),
      cookieSecure: bool('COOKIE_SECURE', env, isProd),
      demoGuestLogin: bool('DEMO_GUEST_LOGIN', env, !isProd),
    },
    worker: {
      embedded: bool('EMBEDDED_WORKER', env, false),
      concurrency: num('WORKER_CONCURRENCY', env, 2),
      pollMs: num('WORKER_POLL_MS', env, 1000),
      roles: (str('WORKER_ROLES', env) ?? 'all').split(',').map((s) => s.trim()),
    },
    ai: {
      openaiKey: str('OPENAI_API_KEY', env),
      anthropicKey: str('ANTHROPIC_API_KEY', env),
      googleKey: str('GOOGLE_API_KEY', env) ?? str('GEMINI_API_KEY', env),
      ollamaBaseUrl: str('OLLAMA_BASE_URL', env),
      providerOrder: (str('AI_PROVIDER_ORDER', env) ?? 'anthropic,openai,google,ollama').split(',').map((s) => s.trim()),
      dailyBudgetUsd: num('AI_DAILY_BUDGET_USD', env, 5),
      maxCostPerTaskUsd: num('AI_MAX_COST_PER_TASK_USD', env, 0.5),
      requestTimeoutMs: num('AI_REQUEST_TIMEOUT_MS', env, 60_000),
    },
    connectors: {
      userAgent: str('HTTP_USER_AGENT', env) ?? 'ROOS-Research-Bot/0.1 (+https://github.com/; contact: set HTTP_USER_AGENT)',
      timeoutMs: num('CONNECTOR_TIMEOUT_MS', env, 15_000),
      maxBytes: num('CONNECTOR_MAX_BYTES', env, 5 * 1024 * 1024),
      githubToken: str('GITHUB_TOKEN', env),
      stackexchangeKey: str('STACKEXCHANGE_KEY', env),
      braveSearchKey: str('BRAVE_SEARCH_API_KEY', env),
      secUserAgent: str('SEC_USER_AGENT', env),
      allowPrivateNetworks: bool('CONNECTOR_ALLOW_PRIVATE_NETWORKS', env, false),
    },
    billing: {
      stripeSecretKey: str('STRIPE_SECRET_KEY', env),
      stripeWebhookSecret: str('STRIPE_WEBHOOK_SECRET', env),
    },
    email: {
      driver: emailDriver,
      resendKey: str('RESEND_API_KEY', env),
      from: str('EMAIL_FROM', env),
      postalAddress: str('COMPANY_POSTAL_ADDRESS', env),
      dailyCap: num('EMAIL_DAILY_CAP', env, 50),
    },
    sandbox: {
      driver: sandboxDriver,
      image: str('SANDBOX_IMAGE', env) ?? 'node:24-alpine',
      timeoutMs: num('SANDBOX_TIMEOUT_MS', env, 60_000),
      memoryMb: num('SANDBOX_MEMORY_MB', env, 256),
      cpus: num('SANDBOX_CPUS', env, 0.5),
      projectsDir: path.resolve(rootDir, str('PROJECTS_DIR', env) ?? path.join(dataDir, 'projects')),
      deployPortStart: num('DEPLOY_PORT_START', env, 5100),
      deployPortEnd: num('DEPLOY_PORT_END', env, 5199),
    },
    scheduler: {
      discoveryIntervalMin: num('DISCOVERY_INTERVAL_MIN', env, 0),
      experimentEvalIntervalMin: num('EXPERIMENT_EVAL_INTERVAL_MIN', env, 15),
      dailyReportHourUtc: num('DAILY_REPORT_HOUR_UTC', env, 7),
    },
    observability: {
      logLevel: (str('LOG_LEVEL', env) ?? 'info') as AppConfig['observability']['logLevel'],
      errorWebhookUrl: str('ERROR_WEBHOOK_URL', env),
    },
  };
}

/** Summary of which integrations are configured — safe to expose (no secret values). */
export function integrationStatus(cfg: AppConfig) {
  return {
    database: cfg.db.url ? 'postgres' : 'pglite (embedded)',
    redis: cfg.redisUrl ? 'configured' : 'not configured (in-memory fallback)',
    ai: {
      anthropic: !!cfg.ai.anthropicKey,
      openai: !!cfg.ai.openaiKey,
      google: !!cfg.ai.googleKey,
      ollama: !!cfg.ai.ollamaBaseUrl,
    },
    connectors: {
      github: cfg.connectors.githubToken ? 'token' : 'anonymous (rate-limited)',
      stackexchange: cfg.connectors.stackexchangeKey ? 'key' : 'anonymous (300 req/day)',
      braveSearch: !!cfg.connectors.braveSearchKey,
      secEdgar: !!cfg.connectors.secUserAgent,
    },
    billing: { stripe: !!cfg.billing.stripeSecretKey, stripeWebhooks: !!cfg.billing.stripeWebhookSecret },
    email: { driver: cfg.email.driver, configured: cfg.email.driver === 'outbox' || !!cfg.email.resendKey },
    sandbox: cfg.sandbox.driver,
    secretsEphemeral: cfg.secrets.ephemeral,
  };
}
