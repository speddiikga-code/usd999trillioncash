import type { Db } from '@roos/database';
import { can, canGrantRole, hashPassword, hashToken, passwordProblems, roleAtLeast, verifyPassword, type Permission } from '@roos/security';
import {
  AppError,
  ConflictError,
  ForbiddenError,
  newId,
  randomToken,
  UnauthorizedError,
  ValidationError,
  type AppConfig,
  type Role,
} from '@roos/shared';
import type { AuditService } from './audit';
import type { OrgService } from './orgs';

export interface Principal {
  kind: 'user' | 'api_key';
  userId: string;
  email: string;
  name: string;
  apiKeyId?: string;
  /** For API keys: the single org and role the key is scoped to. */
  scope?: { orgId: string; role: Role };
}

export interface Membership {
  orgId: string;
  name: string;
  slug: string;
  isDemo: boolean;
  role: Role;
}

const LOCK_AFTER_FAILURES = 5;
const LOCK_MINUTES = 15;

export class AuthService {
  constructor(
    private db: Db,
    private cfg: AppConfig,
    private orgs: OrgService,
    private audit: AuditService,
  ) {}

  async userCount(): Promise<number> {
    // The demo guest is a system user and does not count toward first-run bootstrap.
    return Number(await this.db.value(`SELECT COUNT(*) FROM users WHERE email <> 'demo-guest@roos.local'`));
  }

  /** First user may always register (bootstrap). Later registrations require ALLOW_REGISTRATION. */
  async register(input: { email: string; password: string; name: string; orgName: string }, ip?: string) {
    const count = await this.userCount();
    if (count > 0 && !this.cfg.auth.allowRegistration) throw new ForbiddenError('Registration is disabled. Ask an owner to invite you.');
    const problems = passwordProblems(input.password);
    if (problems.length) throw new ValidationError(`Password ${problems.join(', ')}`);
    if (await this.db.one('SELECT 1 FROM users WHERE email = $1', [input.email])) throw new ConflictError('An account with this email already exists');

    return this.db.tx(async () => {
      const userId = newId('user');
      await this.db.query('INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, $4)', [userId, input.email, input.name, await hashPassword(input.password)]);
      const org = await this.orgs.create(input.orgName);
      await this.db.query(`INSERT INTO memberships (user_id, org_id, role) VALUES ($1, $2, 'owner')`, [userId, org.id]);
      const demo = await this.orgs.demoOrg();
      if (demo) await this.db.query(`INSERT INTO memberships (user_id, org_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING`, [userId, demo.id]);
      await this.audit.record({ orgId: org.id, actor: { type: 'user', id: userId, ip }, action: 'auth.register', targetType: 'user', targetId: userId, details: { email: input.email, firstUser: count === 0 } });
      return { userId, org };
    });
  }

  async login(email: string, password: string, meta: { ip?: string; userAgent?: string } = {}) {
    const user = await this.db.one<Record<string, any>>('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    // Constant-ish time: always run a password hash even when the user does not exist.
    if (!user) {
      await verifyPassword(password, 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA');
      throw new UnauthorizedError('Invalid email or password');
    }
    if (user.disabled) throw new UnauthorizedError('Account disabled');
    if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
      throw new AppError('Too many failed attempts. Try again later.', { status: 429, code: 'ACCOUNT_LOCKED' });
    }
    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) {
      const failures = Number(user.failed_logins) + 1;
      await this.db.query(
        `UPDATE users SET failed_logins = $2::int, locked_until = CASE WHEN $2::int >= $3::int THEN now() + ($4::text || ' minutes')::interval ELSE locked_until END WHERE id = $1`,
        [user.id, failures, LOCK_AFTER_FAILURES, String(LOCK_MINUTES)],
      );
      await this.audit.record({ orgId: null, actor: { type: 'user', id: user.id, ip: meta.ip }, action: 'auth.login', outcome: 'denied', details: { reason: 'bad_password', failures } });
      throw new UnauthorizedError('Invalid email or password');
    }
    await this.db.query('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [user.id]);
    const session = await this.createSession(user.id, meta);
    await this.audit.record({ orgId: null, actor: { type: 'user', id: user.id, ip: meta.ip }, action: 'auth.login', details: { sessionId: session.id } });
    return { ...session, user: { id: user.id as string, email: user.email as string, name: user.name as string } };
  }

  /**
   * Read-only guest session for the synthetic demo workspace. The guest user has an unusable
   * random password and a single `viewer` membership in the demo org — it can never see, create
   * or approve anything in a real workspace.
   */
  async demoGuestSession(meta: { ip?: string; userAgent?: string } = {}) {
    if (!this.cfg.auth.demoGuestLogin) throw new ForbiddenError('Demo guest access is disabled');
    const demo = await this.orgs.demoOrg();
    if (!demo) throw new AppError('The demo workspace has not been seeded', { status: 404, code: 'NOT_FOUND' });
    const email = 'demo-guest@roos.local';
    let userId = await this.db.value<string>('SELECT id FROM users WHERE email = $1', [email]);
    if (!userId) {
      userId = newId('user');
      await this.db.query('INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, $4)', [userId, email, 'Demo guest', `disabled$${randomToken(24)}`]);
    }
    // Guest may belong to the demo org only, and only as a viewer.
    await this.db.query(`DELETE FROM memberships WHERE user_id = $1 AND org_id <> $2`, [userId, demo.id]);
    await this.db.query(`INSERT INTO memberships (user_id, org_id, role) VALUES ($1, $2, 'viewer') ON CONFLICT (user_id, org_id) DO UPDATE SET role = 'viewer'`, [userId, demo.id]);
    const session = await this.createSession(userId, meta);
    await this.audit.record({ orgId: demo.id, actor: { type: 'user', id: userId, ip: meta.ip }, action: 'auth.demo_guest', details: { sessionId: session.id } });
    return { ...session, userId, orgId: demo.id };
  }

  async createSession(userId: string, meta: { ip?: string; userAgent?: string } = {}) {
    const token = randomToken(32);
    const csrfToken = randomToken(24);
    const id = newId('session');
    const expiresAt = new Date(Date.now() + this.cfg.auth.sessionTtlHours * 3_600_000);
    await this.db.query(`INSERT INTO sessions (id, user_id, token_hash, csrf_token, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
      id,
      userId,
      hashToken(token),
      csrfToken,
      meta.ip ?? null,
      meta.userAgent?.slice(0, 300) ?? null,
      expiresAt.toISOString(),
    ]);
    return { id, token, csrfToken, expiresAt: expiresAt.toISOString() };
  }

  async validateSession(token: string): Promise<{ principal: Principal; sessionId: string; csrfToken: string } | null> {
    const row = await this.db.one<Record<string, any>>(
      `SELECT s.id, s.csrf_token, s.last_seen_at, u.id AS user_id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.disabled = false`,
      [hashToken(token)],
    );
    if (!row) return null;
    if (Date.now() - new Date(row.last_seen_at).getTime() > 60_000) await this.db.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [row.id]);
    return { principal: { kind: 'user', userId: row.user_id, email: row.email, name: row.name }, sessionId: row.id, csrfToken: row.csrf_token };
  }

  async logout(token: string) {
    await this.db.query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1', [hashToken(token)]);
  }

  async revokeAllSessions(userId: string) {
    await this.db.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
  }

  async createApiKey(orgId: string, userId: string, name: string, role: Role) {
    const actorRole = await this.roleIn(userId, orgId);
    if (!actorRole || !can(actorRole, 'settings:write')) throw new ForbiddenError('You cannot create API keys in this workspace');
    if (!roleAtLeast(actorRole, role)) throw new ForbiddenError('Cannot create an API key with a role above your own');
    const key = `roos_${randomToken(24)}`;
    const id = newId('apiKey');
    await this.db.query('INSERT INTO api_keys (id, org_id, user_id, name, prefix, key_hash, role) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, orgId, userId, name, key.slice(0, 12), hashToken(key), role]);
    await this.audit.record({ orgId, actor: { type: 'user', id: userId }, action: 'api_key.create', targetType: 'api_key', targetId: id, details: { name, role } });
    return { id, key, prefix: key.slice(0, 12), role, name };
  }

  async validateApiKey(key: string): Promise<Principal | null> {
    if (!key.startsWith('roos_')) return null;
    const row = await this.db.one<Record<string, any>>(
      `SELECT k.id, k.org_id, k.role, k.last_used_at, u.id AS user_id, u.email, u.name FROM api_keys k JOIN users u ON u.id = k.user_id
       WHERE k.key_hash = $1 AND k.revoked_at IS NULL AND u.disabled = false`,
      [hashToken(key)],
    );
    if (!row) return null;
    if (!row.last_used_at || Date.now() - new Date(row.last_used_at).getTime() > 60_000) await this.db.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [row.id]);
    return { kind: 'api_key', userId: row.user_id, email: row.email, name: row.name, apiKeyId: row.id, scope: { orgId: row.org_id, role: row.role } };
  }

  async listApiKeys(orgId: string) {
    return this.db.many(`SELECT id, name, prefix, role, last_used_at, revoked_at, created_at FROM api_keys WHERE org_id = $1 ORDER BY created_at DESC`, [orgId]);
  }

  async revokeApiKey(orgId: string, id: string, actorId: string) {
    await this.db.query('UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND org_id = $2', [id, orgId]);
    await this.audit.record({ orgId, actor: { type: 'user', id: actorId }, action: 'api_key.revoke', targetType: 'api_key', targetId: id });
  }

  async memberships(userId: string): Promise<Membership[]> {
    const rows = await this.db.many<Record<string, any>>(
      `SELECT o.id, o.name, o.slug, o.is_demo, m.role FROM memberships m JOIN organizations o ON o.id = m.org_id WHERE m.user_id = $1 ORDER BY o.is_demo ASC, o.created_at ASC`,
      [userId],
    );
    return rows.map((r) => ({ orgId: r.id, name: r.name, slug: r.slug, isDemo: r.is_demo, role: r.role }));
  }

  async roleIn(userId: string, orgId: string): Promise<Role | null> {
    return (await this.db.value<Role>('SELECT role FROM memberships WHERE user_id = $1 AND org_id = $2', [userId, orgId])) ?? null;
  }

  /** Resolve the effective role of a principal in an org (API keys are pinned to one org). */
  async resolveRole(p: Principal, orgId: string): Promise<Role | null> {
    if (p.scope) return p.scope.orgId === orgId ? p.scope.role : null;
    return this.roleIn(p.userId, orgId);
  }

  can(role: Role, permission: Permission) {
    return can(role, permission);
  }

  async addMember(orgId: string, actorId: string, input: { email: string; name: string; role: Role; password: string }) {
    const actorRole = await this.roleIn(actorId, orgId);
    if (!actorRole || !canGrantRole(actorRole, input.role)) throw new ForbiddenError('You cannot grant this role');
    const problems = passwordProblems(input.password);
    if (problems.length) throw new ValidationError(`Password ${problems.join(', ')}`);
    return this.db.tx(async () => {
      let userId = await this.db.value<string>('SELECT id FROM users WHERE email = $1', [input.email]);
      if (!userId) {
        userId = newId('user');
        await this.db.query('INSERT INTO users (id, email, name, password_hash) VALUES ($1,$2,$3,$4)', [userId, input.email, input.name, await hashPassword(input.password)]);
      }
      await this.db.query(`INSERT INTO memberships (user_id, org_id, role) VALUES ($1,$2,$3) ON CONFLICT (user_id, org_id) DO UPDATE SET role = EXCLUDED.role`, [userId, orgId, input.role]);
      await this.audit.record({ orgId, actor: { type: 'user', id: actorId }, action: 'member.add', targetType: 'user', targetId: userId, details: { role: input.role } });
      return { userId };
    });
  }

  async listMembers(orgId: string) {
    return this.db.many(`SELECT u.id, u.email, u.name, m.role, u.last_login_at FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = $1 ORDER BY m.created_at`, [orgId]);
  }
}
