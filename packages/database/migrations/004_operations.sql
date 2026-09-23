-- 004_operations: products, generated projects, deployments, sandbox runs, experiments,
-- tracking, metrics, customers, revenue, expenses, leads/CRM, campaigns, outbox, approvals,
-- reports, paper ledger, strategy versions (self-improvement).

CREATE TABLE projects (
  id                 text PRIMARY KEY,
  org_id             text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  opportunity_id     text REFERENCES opportunities(id) ON DELETE SET NULL,
  hypothesis_id      text REFERENCES business_hypotheses(id) ON DELETE SET NULL,
  name               text NOT NULL,
  slug               text NOT NULL,
  spec               jsonb NOT NULL,
  path               text NOT NULL,
  manifest           jsonb NOT NULL DEFAULT '[]'::jsonb,
  status             text NOT NULL DEFAULT 'generated' CHECK (status IN ('generated', 'scan_failed', 'tests_passed', 'tests_failed', 'deployed', 'archived')),
  scan_result        jsonb,
  test_result        jsonb,
  generator_version  text NOT NULL,
  is_demo            boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER projects_demo BEFORE INSERT OR UPDATE OF org_id, is_demo ON projects FOR EACH ROW EXECUTE FUNCTION roos_inherit_demo_flag();

CREATE TABLE products (
  id              text PRIMARY KEY,
  org_id          text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  opportunity_id  text REFERENCES opportunities(id) ON DELETE SET NULL,
  project_id      text REFERENCES projects(id) ON DELETE SET NULL,
  name            text NOT NULL,
  description     text NOT NULL DEFAULT '',
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'preview', 'live', 'paused', 'retired')),
  url             text,
  pricing         jsonb NOT NULL DEFAULT '{}'::jsonb,
  business_model  text,
  write_key       text NOT NULL UNIQUE,
  launched_at     timestamptz,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER products_demo BEFORE INSERT OR UPDATE OF org_id, is_demo ON products FOR EACH ROW EXECUTE FUNCTION roos_inherit_demo_flag();

CREATE TABLE deployments (
  id            text PRIMARY KEY,
  org_id        text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id    text REFERENCES projects(id) ON DELETE CASCADE,
  product_id    text REFERENCES products(id) ON DELETE SET NULL,
  environment   text NOT NULL CHECK (environment IN ('local', 'staging', 'production')),
  driver        text NOT NULL CHECK (driver IN ('process', 'docker', 'manual')),
  status        text NOT NULL CHECK (status IN ('pending_approval', 'starting', 'running', 'stopped', 'failed', 'pending_manual')),
  url           text,
  port          integer,
  pid           integer,
  container_id  text,
  approval_id   text,
  logs          text NOT NULL DEFAULT '',
  error         text,
  started_at    timestamptz,
  stopped_at    timestamptz,
  is_demo       boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER deployments_demo BEFORE INSERT OR UPDATE OF org_id, is_demo ON deployments FOR EACH ROW EXECUTE FUNCTION roos_inherit_demo_flag();

CREATE TABLE sandbox_runs (
  id           text PRIMARY KEY,
  org_id       text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id   text REFERENCES projects(id) ON DELETE CASCADE,
  driver       text NOT NULL,
  command      text NOT NULL,
  status       text NOT NULL CHECK (status IN ('passed', 'failed', 'timeout', 'error', 'skipped')),
  exit_code    integer,
  stdout       text NOT NULL DEFAULT '',
  stderr       text NOT NULL DEFAULT '',
  duration_ms  integer NOT NULL DEFAULT 0,
  limits       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE experiments (
  id                   text PRIMARY KEY,
  org_id               text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  opportunity_id       text REFERENCES opportunities(id) ON DELETE SET NULL,
  product_id           text REFERENCES products(id) ON DELETE SET NULL,
  hypothesis_id        text REFERENCES business_hypotheses(id) ON DELETE SET NULL,
  name                 text NOT NULL,
  hypothesis           text NOT NULL,
  funnel               jsonb NOT NULL,
  primary_numerator    text NOT NULL,
  primary_denominator  text NOT NULL,
  variants             jsonb NOT NULL DEFAULT '["control"]'::jsonb,
  variant_copy         jsonb NOT NULL DEFAULT '{}'::jsonb,
  thresholds           jsonb NOT NULL,
  budget_usd           double precision NOT NULL DEFAULT 0 CHECK (budget_usd >= 0),
  spent_usd            double precision NOT NULL DEFAULT 0 CHECK (spent_usd >= 0),
  status               text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_approval', 'running', 'paused', 'completed', 'killed', 'cancelled')),
  decision             text CHECK (decision IN ('SCALE', 'ITERATE', 'PAUSE', 'KILL', 'CONTINUE')),
  decision_rationale   jsonb,
  approval_id          text,
  started_at           timestamptz,
  ended_at             timestamptz,
  last_evaluated_at    timestamptz,
  is_demo              boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX experiments_org_status_idx ON experiments (org_id, status);
CREATE TRIGGER experiments_demo BEFORE INSERT OR UPDATE OF org_id, is_demo ON experiments FOR EACH ROW EXECUTE FUNCTION roos_inherit_demo_flag();

CREATE TABLE experiment_evaluations (
  id             bigserial PRIMARY KEY,
  org_id         text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  experiment_id  text NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  decision       text NOT NULL,
  result         jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX experiment_evaluations_idx ON experiment_evaluations (experiment_id, created_at DESC);

-- Raw funnel events posted by launched products (landing pages, MVPs) via the public track API.
CREATE TABLE tracking_events (
  id                text PRIMARY KEY,
  org_id            text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_id        text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  experiment_id     text REFERENCES experiments(id) ON DELETE SET NULL,
  variant           text,
  event             text NOT NULL,
  anonymous_id      text NOT NULL,
  lead_id           text,
  ref               text,
  path              text,
  value_usd         double precision,
  properties        jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at       timestamptz NOT NULL,
  received_at       timestamptz NOT NULL DEFAULT now(),
  ip_hash           text,
  user_agent_class  text,
  is_bot            boolean NOT NULL DEFAULT false,
  is_demo           boolean NOT NULL DEFAULT false
);
CREATE INDEX tracking_events_experiment_idx ON tracking_events (experiment_id, event, variant);
CREATE INDEX tracking_events_product_idx ON tracking_events (product_id, occurred_at);
CREATE TRIGGER tracking_events_demo BEFORE INSERT OR UPDATE OF org_id, is_demo ON tracking_events FOR EACH ROW EXECUTE FUNCTION roos_inherit_demo_flag();

CREATE TABLE metrics (
  id            text PRIMARY KEY,
  org_id        text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entity_type   text NOT NULL,
  entity_id     text,
  name          text NOT NULL,
  value         double precision NOT NULL,
  unit          text,
  period_start  timestamptz,
  period_end    timestamptz,
  data_kind     text NOT NULL CHECK (data_kind IN ('OBSERVED', 'ESTIMATED', 'MODEL_ASSUMPTION', 'USER_INPUT', 'DEMO')),
  source        text,
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  is_demo       boolean NOT NULL DEFAULT false
);
CREATE INDEX metrics_lookup_idx ON metrics (org_id, name, recorded_at DESC);
CREATE TRIGGER metrics_demo BEFORE INSERT OR UPDATE OF org_id, is_demo ON metrics FOR EACH ROW EXECUTE FUNCTION roos_inherit_demo_flag();

CREATE TABLE customers (
  id           text PRIMARY KEY,
  org_id       text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_id   text REFERENCES products(id) ON DELETE SET NULL,
  external_id  text,
  email_hash   text,
  name         text,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('trial', 'active', 'churned')),
  mrr_usd      double precision NOT NULL DEFAULT 0,
  source       text NOT NULL CHECK (source IN ('stripe', 'manual', 'tracking', 'demo')),
  lead_id      text,
  started_at   timestamptz NOT NULL DEFAULT now(),
  churned_at   timestamptz,
  is_demo      boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, source, external_id)
);
CREATE TRIGGER customers_demo BEFORE INSERT OR UPDATE OF org_id, is_demo ON customers FOR EACH ROW EXECUTE FUNCTION roos_inherit_demo_flag();

-- Revenue ledger. `verified` may only be true for provider-verified events (Stripe signature-checked
-- webhooks or API sync). Manual entries are USER_INPUT and never count as verified revenue.
CREATE TABLE revenue_events (
  id             text PRIMARY KEY,
  org_id         text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_id     text REFERENCES products(id) ON DELETE SET NULL,
  customer_id    text REFERENCES customers(id) ON DELETE SET NULL,
  type           text NOT NULL CHECK (type IN ('charge', 'refund', 'subscription_started', 'subscription_changed', 'subscription_canceled')),
  amount_usd     double precision NOT NULL DEFAULT 0,
  mrr_delta_usd  double precision NOT NULL DEFAULT 0,
  currency       text NOT NULL DEFAULT 'usd',
  occurred_at    timestamptz NOT NULL,
  source         text NOT NULL CHECK (source IN ('stripe', 'manual', 'demo', 'simulation')),
  external_id    text,
  verified       boolean NOT NULL DEFAULT false,
  verification   jsonb NOT NULL DEFAULT '{}'::jsonb,
  note           text,
  is_demo        boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, source, external_id),
  CONSTRAINT revenue_verified_only_from_provider CHECK (NOT verified OR source = 'stripe'),
  CONSTRAINT revenue_demo_never_verified CHECK (NOT (is_demo AND verified))
);
CREATE INDEX revenue_events_org_time_idx ON revenue_events (org_id, occurred_at);
CREATE TRIGGER revenue_events_demo BEFORE INSERT OR UPDATE OF org_id, is_demo ON revenue_events FOR EACH ROW EXECUTE FUNCTION roos_inherit_demo_flag();

CREATE TABLE expenses (
  id             text PRIMARY KEY,
  org_id         text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_id     text REFERENCES products(id) ON DELETE SET NULL,
  experiment_id  text REFERENCES experiments(id) ON DELETE SET NULL,
  category       text NOT NULL CHECK (category IN ('ads', 'infrastructure', 'ai', 'tools', 'contractors', 'payment_fees', 'other')),
  amount_usd     double precision NOT NULL CHECK (amount_usd >= 0),
  occurred_at    timestamptz NOT NULL,
  description    text,
  source         text NOT NULL CHECK (source IN ('manual', 'ai_usage', 'simulation', 'demo', 'provider')),
  verified       boolean NOT NULL DEFAULT false,
  is_demo        boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX expenses_org_time_idx ON expenses (org_id, occurred_at);
CREATE TRIGGER expenses_demo BEFORE INSERT OR UPDATE OF org_id, is_demo ON expenses FOR EACH ROW EXECUTE FUNCTION roos_inherit_demo_flag();

CREATE TABLE leads (
  id                 text PRIMARY KEY,
  org_id             text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  opportunity_id     text REFERENCES opportunities(id) ON DELETE SET NULL,
  product_id         text REFERENCES products(id) ON DELETE SET NULL,
  name               text NOT NULL,
  email              text,
  email_hash         text,
  company            text,
  title              text,
  website            text,
  source             text NOT NULL,
  consent_basis      text NOT NULL CHECK (consent_basis IN ('inbound', 'opt_in', 'existing_customer', 'legitimate_interest', 'unknown')),
  status             text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'qualified', 'contacted', 'replied', 'demo', 'customer', 'lost', 'unsubscribed')),
  score              double precision NOT NULL DEFAULT 0,
  score_breakdown    jsonb NOT NULL DEFAULT '{}'::jsonb,
  referral_code      text UNIQUE,
  referred_by        text,
  anonymous_id       text,
  notes              text,
  last_contacted_at  timestamptz,
  is_demo            boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, email)
);
CREATE INDEX leads_org_status_idx ON leads (org_id, status, score DESC);
CREATE TRIGGER leads_demo BEFORE INSERT OR UPDATE OF org_id, is_demo ON leads FOR EACH ROW EXECUTE FUNCTION roos_inherit_demo_flag();

CREATE TABLE campaigns (
  id                text PRIMARY KEY,
  org_id            text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_id        text REFERENCES products(id) ON DELETE SET NULL,
  opportunity_id    text REFERENCES opportunities(id) ON DELETE SET NULL,
  experiment_id     text REFERENCES experiments(id) ON DELETE SET NULL,
  name              text NOT NULL,
  channel           text NOT NULL DEFAULT 'email',
  status            text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_approval', 'approved', 'sending', 'sent', 'rejected', 'cancelled')),
  subject_template  text NOT NULL,
  body_template     text NOT NULL,
  audience          jsonb NOT NULL DEFAULT '{}'::jsonb,
  stats             jsonb NOT NULL DEFAULT '{}'::jsonb,
  approval_id       text,
  created_by        text NOT NULL,
  is_demo           boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER campaigns_demo BEFORE INSERT OR UPDATE OF org_id, is_demo ON campaigns FOR EACH ROW EXECUTE FUNCTION roos_inherit_demo_flag();

CREATE TABLE outbox_messages (
  id                   text PRIMARY KEY,
  org_id               text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  campaign_id          text REFERENCES campaigns(id) ON DELETE CASCADE,
  lead_id              text REFERENCES leads(id) ON DELETE SET NULL,
  channel              text NOT NULL DEFAULT 'email',
  to_address           text NOT NULL,
  subject              text NOT NULL,
  body                 text NOT NULL,
  status               text NOT NULL DEFAULT 'drafted' CHECK (status IN ('drafted', 'approved', 'sent', 'failed', 'suppressed', 'skipped')),
  provider             text,
  provider_message_id  text,
  error                text,
  sent_at              timestamptz,
  is_demo              boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_campaign_idx ON outbox_messages (campaign_id, status);
CREATE TRIGGER outbox_demo BEFORE INSERT OR UPDATE OF org_id, is_demo ON outbox_messages FOR EACH ROW EXECUTE FUNCTION roos_inherit_demo_flag();

CREATE TABLE suppressions (
  org_id      text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email_hash  text NOT NULL,
  reason      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, email_hash)
);

-- Human approval center. Shows WHAT / WHY / BENEFIT / COST / RISK / DATA SOURCES / REVERSIBILITY.
CREATE TABLE approvals (
  id                 text PRIMARY KEY,
  org_id             text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  action_type        text NOT NULL,
  title              text NOT NULL,
  what               text NOT NULL,
  why                text NOT NULL,
  expected_benefit   text NOT NULL,
  expected_cost_usd  double precision NOT NULL DEFAULT 0,
  risk               jsonb NOT NULL,
  data_sources       jsonb NOT NULL DEFAULT '[]'::jsonb,
  reversibility      text NOT NULL CHECK (reversibility IN ('reversible', 'partially_reversible', 'irreversible')),
  payload            jsonb NOT NULL DEFAULT '{}'::jsonb,
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'executed', 'failed')),
  requested_by       text NOT NULL,
  task_id            text,
  decided_by         text,
  decided_at         timestamptz,
  decision_note      text,
  expires_at         timestamptz,
  result             jsonb,
  executed_at        timestamptz,
  is_demo            boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX approvals_org_status_idx ON approvals (org_id, status, created_at DESC);
CREATE TRIGGER approvals_demo BEFORE INSERT OR UPDATE OF org_id, is_demo ON approvals FOR EACH ROW EXECUTE FUNCTION roos_inherit_demo_flag();

CREATE TABLE reports (
  id            text PRIMARY KEY,
  org_id        text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind          text NOT NULL,
  period_start  timestamptz NOT NULL,
  period_end    timestamptz NOT NULL,
  title         text NOT NULL,
  content       jsonb NOT NULL,
  markdown      text NOT NULL,
  is_demo       boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reports_org_idx ON reports (org_id, created_at DESC);
CREATE TRIGGER reports_demo BEFORE INSERT OR UPDATE OF org_id, is_demo ON reports FOR EACH ROW EXECUTE FUNCTION roos_inherit_demo_flag();

-- Paper (simulated) financial ledger — SIMULATE mode records would-be financial effects here.
CREATE TABLE paper_ledger (
  id             text PRIMARY KEY,
  org_id         text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  account        text NOT NULL,
  entry_type     text NOT NULL,
  amount_usd     double precision NOT NULL,
  memo           text,
  approval_id    text,
  experiment_id  text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Versioned strategy parameters learned from empirical outcomes (e.g. scoring weights).
CREATE TABLE strategy_versions (
  id          text PRIMARY KEY,
  org_id      text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  version     integer NOT NULL,
  params      jsonb NOT NULL,
  metrics     jsonb NOT NULL DEFAULT '{}'::jsonb,
  status      text NOT NULL CHECK (status IN ('active', 'candidate', 'retired')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, kind, version)
);
