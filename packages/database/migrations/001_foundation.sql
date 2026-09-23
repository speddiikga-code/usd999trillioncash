-- 001_foundation: tenancy, identity, secrets, policies, audit log, event log.

CREATE TABLE organizations (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  slug        text NOT NULL UNIQUE,
  is_demo     boolean NOT NULL DEFAULT false,
  settings    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Every tenant-scoped row inherits is_demo from its organisation. This makes it impossible
-- for synthetic demo data to be written into a real workspace (or vice versa), regardless of
-- what application code passes in.
CREATE OR REPLACE FUNCTION roos_inherit_demo_flag() RETURNS trigger AS $$
DECLARE
  org_demo boolean;
BEGIN
  SELECT o.is_demo INTO org_demo FROM organizations o WHERE o.id = NEW.org_id;
  NEW.is_demo := COALESCE(org_demo, false);
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TABLE users (
  id             text PRIMARY KEY,
  email          text NOT NULL UNIQUE,
  name           text NOT NULL,
  password_hash  text NOT NULL,
  disabled       boolean NOT NULL DEFAULT false,
  failed_logins  integer NOT NULL DEFAULT 0,
  locked_until   timestamptz,
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id      text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('owner', 'admin', 'operator', 'analyst', 'viewer')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, org_id)
);

CREATE TABLE sessions (
  id            text PRIMARY KEY,
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,
  csrf_token    text NOT NULL,
  ip            text,
  user_agent    text,
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE api_keys (
  id            text PRIMARY KEY,
  org_id        text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          text NOT NULL,
  prefix        text NOT NULL,
  key_hash      text NOT NULL UNIQUE,
  role          text NOT NULL CHECK (role IN ('owner', 'admin', 'operator', 'analyst', 'viewer')),
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Per-organisation encrypted secrets (AES-256-GCM). Plaintext never touches the database.
CREATE TABLE secrets (
  id          text PRIMARY KEY,
  org_id      text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        text NOT NULL,
  ciphertext  text NOT NULL,
  iv          text NOT NULL,
  tag         text NOT NULL,
  key_id      text NOT NULL,
  hint        text,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);

-- Action permission policies (READ_ONLY / SIMULATE / REQUIRE_APPROVAL / AUTONOMOUS).
-- Hard ceilings are enforced in code (packages/shared ACTIONS.maxMode).
CREATE TABLE policies (
  org_id      text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  action      text NOT NULL,
  mode        text NOT NULL CHECK (mode IN ('READ_ONLY', 'SIMULATE', 'REQUIRE_APPROVAL', 'AUTONOMOUS')),
  limits      jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, action)
);

-- Tamper-evident, append-only audit log. Each row stores the hash of the previous row for the
-- same organisation (hash chain). No FK to organizations so records outlive their tenant.
CREATE TABLE audit_logs (
  id           text PRIMARY KEY,
  seq          bigserial NOT NULL UNIQUE,
  org_id       text,
  actor_type   text NOT NULL CHECK (actor_type IN ('user', 'agent', 'system', 'api_key', 'webhook')),
  actor_id     text NOT NULL,
  action       text NOT NULL,
  target_type  text,
  target_id    text,
  outcome      text NOT NULL DEFAULT 'success' CHECK (outcome IN ('success', 'denied', 'failed', 'pending')),
  details      jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip           text,
  prev_hash    text,
  hash         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_org_seq_idx ON audit_logs (org_id, seq DESC);
CREATE INDEX audit_logs_target_idx ON audit_logs (target_type, target_id);

CREATE OR REPLACE FUNCTION roos_audit_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_no_update BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION roos_audit_immutable();

-- Append-only event log (event-driven architecture; streamed to the dashboard over SSE).
CREATE TABLE events (
  id           bigserial PRIMARY KEY,
  org_id       text,
  type         text NOT NULL,
  entity_type  text,
  entity_id    text,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_org_id_idx ON events (org_id, id);

CREATE TABLE alerts (
  id               text PRIMARY KEY,
  org_id           text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  severity         text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  title            text NOT NULL,
  message          text NOT NULL,
  entity_type      text,
  entity_id        text,
  acknowledged_at  timestamptz,
  acknowledged_by  text,
  is_demo          boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX alerts_org_idx ON alerts (org_id, acknowledged_at, created_at DESC);
CREATE TRIGGER alerts_demo BEFORE INSERT OR UPDATE OF org_id, is_demo ON alerts FOR EACH ROW EXECUTE FUNCTION roos_inherit_demo_flag();
