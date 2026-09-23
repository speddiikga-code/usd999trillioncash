import { bootstrapCore } from './bootstrap';
import { seedDemo } from './demo';

/**
 * Administrative CLI (runs against the database directly):
 *   tsx packages/core/src/cli.ts seed-demo [--reset]
 *   tsx packages/core/src/cli.ts bootstrap-admin <email> <password> [name]
 *   tsx packages/core/src/cli.ts verify-audit <orgId>
 *   tsx packages/core/src/cli.ts rotate-secrets
 * With embedded PGlite, stop the API first (single-process database).
 */
const [cmd, ...args] = process.argv.slice(2);
const { core, db, redis, logger } = await bootstrapCore({ service: 'cli' });
try {
  switch (cmd) {
    case 'seed-demo': {
      const r = await seedDemo(core, { reset: args.includes('--reset') });
      logger.info(r.created ? 'Demo workspace created (synthetic data)' : 'Demo workspace already exists (use --reset to recreate)', r);
      break;
    }
    case 'bootstrap-admin': {
      const [email, password, name] = args;
      if (!email || !password) throw new Error('Usage: bootstrap-admin <email> <password> [name]');
      const r = await core.auth.register({ email: email.toLowerCase(), password, name: name ?? 'Admin', orgName: 'My Workspace' });
      const key = await core.auth.createApiKey(r.org.id, r.userId, 'bootstrap', 'owner');
      console.log(JSON.stringify({ userId: r.userId, orgId: r.org.id, apiKey: key.key, note: 'Store the API key now — it is shown only once.' }, null, 2));
      break;
    }
    case 'verify-audit': {
      console.log(JSON.stringify(await core.audit.verifyChain(args[0] ?? ''), null, 2));
      break;
    }
    case 'rotate-secrets': {
      console.log(`Re-encrypted ${await core.secrets.rotate()} secret(s) with the current ENCRYPTION_KEY`);
      break;
    }
    default:
      console.error('Commands: seed-demo [--reset] | bootstrap-admin <email> <password> [name] | verify-audit <orgId> | rotate-secrets');
      process.exitCode = 1;
  }
} finally {
  await db.close();
  await redis?.quit();
}
