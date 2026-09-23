-- 003_agents: agent registry, task queue, memory, tracing, AI model calls and pricing.

CREATE TABLE agents (
  org_id        text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name          text NOT NULL,
  description   text NOT NULL,
  enabled       boolean NOT NULL DEFAULT true,
  tools         jsonb NOT NULL DEFAULT '[]'::jsonb,
  budget        jsonb NOT NULL DEFAULT '{}'::jsonb,
  timeout_ms    integer NOT NULL DEFAULT 120000,
  retry_policy  jsonb NOT NULL DEFAULT '{}'::jsonb,
  model_tier    text NOT NULL DEFAULT 'balanced' CHECK (model_tier IN ('fast', 'balanced', 'deep')),
  status        text NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'running', 'disabled', 'error')),
  last_run_at   timestamptz,
  stats         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, name)
);

-- Durable task queue for agents (claimed with FOR UPDATE SKIP LOCKED).
CREATE TABLE agent_tasks (
  id               text PRIMARY KEY,
  org_id           text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent            text NOT NULL,
  kind             text NOT NULL,
  input            jsonb NOT NULL DEFAULT '{}'::jsonb,
  output           jsonb,
  status           text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'waiting_approval', 'cancelled', 'timed_out')),
  priority         integer NOT NULL DEFAULT 0,
  attempts         integer NOT NULL DEFAULT 0,
  max_attempts     integer NOT NULL DEFAULT 3,
  run_after        timestamptz NOT NULL DEFAULT now(),
  timeout_ms       integer NOT NULL DEFAULT 120000,
  locked_by        text,
  locked_at        timestamptz,
  parent_id        text REFERENCES agent_tasks(id) ON DELETE SET NULL,
  workflow_id      text,
  approval_id      text,
  error            text,
  cost_usd         double precision NOT NULL DEFAULT 0,
  tokens           integer NOT NULL DEFAULT 0,
  created_by       text NOT NULL DEFAULT 'system',
  idempotency_key  text,
  started_at       timestamptz,
  finished_at      timestamptz,
  is_demo          boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_tasks_claim_idx ON agent_tasks (run_after, priority DESC) WHERE status = 'queued';
CREATE INDEX agent_tasks_org_idx ON agent_tasks (org_id, created_at DESC);
CREATE INDEX agent_tasks_workflow_idx ON agent_tasks (workflow_id);
CREATE INDEX agent_tasks_running_idx ON agent_tasks (locked_at) WHERE status = 'running';
CREATE UNIQUE INDEX agent_tasks_idem_idx ON agent_tasks (org_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TRIGGER agent_tasks_demo BEFORE INSERT OR UPDATE OF org_id, is_demo ON agent_tasks FOR EACH ROW EXECUTE FUNCTION roos_inherit_demo_flag();

-- Long-lived agent memory: facts and lessons learned, scoped (e.g. per opportunity).
CREATE TABLE agent_memory (
  id              text PRIMARY KEY,
  org_id          text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent           text NOT NULL,
  scope           text,
  kind            text NOT NULL CHECK (kind IN ('fact', 'lesson', 'preference', 'summary', 'warning')),
  content         text NOT NULL,
  data            jsonb NOT NULL DEFAULT '{}'::jsonb,
  importance      double precision NOT NULL DEFAULT 0.5,
  source_task_id  text,
  expires_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_memory_lookup_idx ON agent_memory (org_id, agent, scope, created_at DESC);

-- Execution tracing: one span per task / step / tool call / model call / policy check.
CREATE TABLE agent_spans (
  id              text PRIMARY KEY,
  org_id          text NOT NULL,
  task_id         text NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  parent_span_id  text,
  name            text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('task', 'step', 'tool', 'model', 'policy')),
  status          text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'error', 'denied', 'approval_required')),
  started_at      timestamptz NOT NULL,
  ended_at        timestamptz,
  duration_ms     integer,
  attributes      jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX agent_spans_task_idx ON agent_spans (task_id, started_at);

CREATE TABLE model_calls (
  id             text PRIMARY KEY,
  org_id         text,
  task_id        text,
  agent          text,
  provider       text NOT NULL,
  model          text NOT NULL,
  purpose        text NOT NULL,
  tier           text,
  input_tokens   integer NOT NULL DEFAULT 0,
  output_tokens  integer NOT NULL DEFAULT 0,
  cost_usd       double precision NOT NULL DEFAULT 0,
  latency_ms     integer NOT NULL DEFAULT 0,
  status         text NOT NULL CHECK (status IN ('ok', 'error', 'invalid_output', 'rate_limited', 'budget_denied')),
  error          text,
  quality        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX model_calls_org_idx ON model_calls (org_id, created_at DESC);
CREATE INDEX model_calls_model_idx ON model_calls (provider, model, created_at DESC);

-- Liveness of worker processes (system-health panel).
CREATE TABLE worker_heartbeats (
  worker_id     text PRIMARY KEY,
  roles         jsonb NOT NULL DEFAULT '[]'::jsonb,
  info          jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now()
);

-- Model pricing table (USD per million tokens). Seeded from packages/ai/src/pricing.ts; editable.
CREATE TABLE model_costs (
  provider             text NOT NULL,
  model                text NOT NULL,
  tier                 text NOT NULL CHECK (tier IN ('fast', 'balanced', 'deep')),
  input_per_mtok_usd   double precision NOT NULL,
  output_per_mtok_usd  double precision NOT NULL,
  context_window       integer,
  source_note          text,
  user_override        boolean NOT NULL DEFAULT false,
  effective_from       date NOT NULL DEFAULT CURRENT_DATE,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, model)
);
