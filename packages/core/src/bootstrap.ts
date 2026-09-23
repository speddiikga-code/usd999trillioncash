import { connectDb } from '@roos/database';
import { createLogger, loadConfig, loadEnvFile, type AppConfig, type Logger } from '@roos/shared';
import { Core, type CoreOptions } from './core';

export interface RedisClient {
  publish(channel: string, message: string): Promise<unknown>;
  ping(): Promise<string>;
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number): Promise<number>;
  pttl(key: string): Promise<number>;
  quit(): Promise<unknown>;
}

/** Optional Redis connection (rate limiting + event fan-out). Falls back to in-memory when unavailable. */
export async function connectRedis(cfg: AppConfig, logger: Logger): Promise<RedisClient | undefined> {
  if (!cfg.redisUrl) return undefined;
  const mod = await import('ioredis');
  const Redis = (mod as any).default ?? (mod as any).Redis;
  const client = new Redis(cfg.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 1500,
    enableOfflineQueue: false,
    // Reconnect with backoff once connected; the initial probe below gives up quickly instead.
    retryStrategy: (times: number) => Math.min(times * 500, 5000),
  });
  let lastLogged = 0;
  client.on('error', (e: Error) => {
    if (Date.now() - lastLogged > 60_000) {
      lastLogged = Date.now();
      logger.warn('Redis connection error', { error: e.message });
    }
  });
  try {
    await client.connect();
    await client.ping();
    logger.info('Connected to Redis');
    return client as RedisClient;
  } catch (e) {
    client.disconnect();
    if (cfg.isProd) throw e;
    logger.warn('Redis unavailable — using in-memory rate limiting and event fan-out', { error: (e as Error).message });
    return undefined;
  }
}

/** Load env + config, connect database (and Redis), migrate, and build the service container. */
export async function bootstrapCore(opts: { service: string; overrides?: Partial<CoreOptions> } = { service: 'roos' }) {
  loadEnvFile();
  const cfg = loadConfig();
  const logger = createLogger({ level: cfg.observability.logLevel, bindings: { service: opts.service } });
  if (cfg.secrets.ephemeral) logger.warn('APP_SECRET / ENCRYPTION_KEY not set — using ephemeral secrets (development only). Run `npm run dev` once to generate .env.');
  const db = await connectDb(cfg, logger);
  const redis = await connectRedis(cfg, logger);
  const core = new Core({ db, cfg, logger, redis, ...(opts.overrides ?? {}) });
  await core.init();
  return { core, cfg, logger, db, redis };
}
