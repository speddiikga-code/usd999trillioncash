# Architecture

ROOS is a TypeScript monorepo (npm workspaces). The processes are:

- **api** (Fastify): REST, server-sent events, public tracking and webhooks
- **worker**: the agent queue plus the scheduler
- **dashboard** (Next.js)
- **cli**

All four share PostgreSQL through `@roos/core`, the domain layer. Redis is optional and backs
distributed rate limiting.

```text
             ┌────────────┐   /api (rewrites)   ┌──────────────────────────────┐
 browser ───▶│ dashboard  │────────────────────▶│ api (Fastify)                │
             └────────────┘                     │  auth · RBAC · CSRF · limits │
 CLI / keys ───────────────────────────────────▶│  routes → @roos/core         │
 MVPs / sites ── POST /api/track (write key) ──▶│  SSE  /api/events/stream     │
 Stripe ──────── POST /api/webhooks/stripe ────▶│                              │
                                                └──────────────┬───────────────┘
                                                               │ agent_tasks (queue)
                                                ┌──────────────▼───────────────┐
                                                │ worker: Orchestrator + 11    │
                                                │ agents + Scheduler           │
                                                │  tools → core services       │
                                                │  model router · connectors   │
                                                │  factory (sandbox, deploy)   │
                                                └──────────────┬───────────────┘
                                                               ▼
                                     PostgreSQL (or embedded PGlite)  ·  Redis (optional)
```

## Packages

| Package | Responsibility |
|---|---|
| `@roos/shared` | Domain types, the **provenance model** (`EstimatedValue`, `DataKind`), the policy action catalogue, Zod input schemas, config loading, ids, the logger |
| `@roos/database` | `Db` over `pg` or PGlite. `Db.tx` uses AsyncLocalStorage so nested calls join the active transaction. Also: the migration runner (checksums, advisory lock) and `createTestDb` |
| `@roos/security` | scrypt passwords; AES-256-GCM secrets (org id as AAD, key rotation); HMAC tokens; RBAC; SSRF-safe fetch; rate limiters; prompt-injection scanning and fencing; HTML escaping; static code scanner |
| `@roos/ai` | `ModelRouter` (provider order, fallback, per-tier models, budget guard, RPM limits, schema-validated JSON with one repair attempt, quality stats). Providers: Anthropic (official SDK), OpenAI, Gemini, Ollama, Mock |
| `@roos/connectors` | Public data sources returning `SourceDocument`s with provenance. Adds robots.txt handling, politeness delays, caching and per-source error isolation |
| `@roos/analytics` | Pure maths: Beta posteriors, Wilson intervals, Monte Carlo, scoring, experiment decisions, Thompson-sampling allocation, roadmap, cash-flow projections, logistic recalibration, TF-IDF clustering, pain and willingness-to-pay signals, lead scoring, SaaS metrics |
| `@roos/billing` | Stripe signature verification, event normalisation and a read-only client (creating a payment link is the only write) |
| `@roos/factory` | MVP spec → zero-dependency Node app from vetted templates. Also the sandbox runner (Docker or Node permission model) and the local preview deployer |
| `@roos/core` | Domain services: orgs, auth, secrets, policy, approvals, audit, events, alerts, graph, discovery, analysis, opportunities, products, tracking, experiments, leads, campaigns, revenue, portfolio, reports, strategy, demo, system |
| `@roos/agents` | Agent definitions, tool registry, `Orchestrator` (queue), `CommandCenter` (`/research` …), `Scheduler` |

## Data provenance

Every claim that reaches the UI carries `{ value, low, high, kind, confidence, source(s), timestamp,
rationale }`:

- **OBSERVED**: read from a source document. Evidence rows keep `source_url`, the connector,
  `retrieved_at`, a verbatim quote and an injection score.
- **ESTIMATED**: derived from observations by a stated method, always with a range.
- **MODEL_ASSUMPTION**: a prior or a model's guess. It gets low confidence and never counts as
  evidence.
- **USER_INPUT**: entered by a person.
- **DEMO**: synthetic. It lives only in demo organisations; a database trigger sets
  `is_demo` from the organisation, so a demo row cannot appear in a real workspace.

When an AI model contributes a claim, the claim must cite a document index and quote it
**verbatim**. Claims whose quote isn't found in the cited document are discarded
(`core/analysis.ts`, `core/discovery.ts`). Untrusted text is always wrapped in a
random-boundary fence and scanned for prompt injection. Suspicious documents are kept, but as
down-weighted data.

## Data model (PostgreSQL)

The four migrations are in `packages/database/migrations`:

| Area | Tables |
|---|---|
| Tenancy and security | `organizations`, `users`, `memberships`, `sessions`, `api_keys`, `secrets`, `policies`, `audit_logs` (append-only via trigger, SHA-256 hash chain), `events`, `alerts` |
| Research | `sources`, `documents`, `markets`, `companies`, `opportunities`, `evidence`, `business_hypotheses`, `opportunity_scores`, `kg_nodes`, `kg_edges` |
| Agents | `agents`, `agent_tasks`, `agent_memory`, `agent_spans`, `model_calls`, `model_costs`, `worker_heartbeats` |
| Operations | `projects`, `products`, `deployments`, `sandbox_runs`, `experiments`, `experiment_evaluations`, `tracking_events`, `metrics`, `customers`, `revenue_events`, `expenses`, `leads`, `campaigns`, `outbox_messages`, `suppressions`, `approvals`, `reports`, `paper_ledger`, `strategy_versions` |

Integrity rules enforced **in the database**, not only in code:

- `revenue_events.verified` can be true only for payment-provider sources, and never for demo
  rows.
- Audit rows can't be updated or deleted.
- `is_demo` is inherited from the organisation.

The knowledge graph (`kg_nodes`/`kg_edges`) sits behind `GraphService`, so it could move to a
dedicated graph store later without changing callers.

## Agents and the queue

Eleven agents, each with an explicit **tool allow-list**, a model tier, a timeout, a retry
policy and a daily budget:

| Agent | Does |
|---|---|
| ResearchAgent | Collects public data and turns pain signals into opportunities |
| MarketAgent | Market sizing, competition and several business-model hypotheses |
| CustomerAgent | ICPs and transparent lead scoring (never contacts anyone) |
| ProductAgent | Selected hypothesis → MVP spec |
| CodeAgent | Generates code from templates, sandbox-tests it, deploys previews, requests production deploys |
| GrowthAgent | Designs experiments with pre-registered thresholds; spend is approval-gated |
| SalesAgent | Drafts consent-aware outreach; sending always goes through approvals |
| FinanceAgent | Unit economics, portfolio allocation, cash-flow projections (recommendations only) |
| AnalyticsAgent | Evaluates experiments, writes daily reports, recalibrates strategy |
| RiskAgent | Regulatory and ethical screening, prompt-injection review |
| SecurityAgent | Reviews generated builds, verifies the audit chain, reports posture |

Agents communicate only through **structured tasks** in `agent_tasks`. A handler returns
`{ output, next[] }` and the orchestrator enqueues the follow-up tasks in the same workflow.

- **Claiming**: workers claim tasks with `SELECT … FOR UPDATE SKIP LOCKED`, so you can run as
  many workers as you want.
- **Retries**: failures back off exponentially up to `maxAttempts`.
- **Timeouts**: each task has one; a stale claim from a dead worker is re-queued.
- **Tool calls**: every call is checked against the allow-list *and* the policy engine, and is
  recorded as a span with its cost.
- **Approvals**: if a tool needs approval, the task moves to `waiting_approval` and records the
  approval id. Approving resumes it; rejecting cancels it.
- **Memory**: `agent_memory` stores lessons (e.g. experiment outcomes) for later recall.

The `Scheduler` enqueues periodic work as idempotent tasks with deterministic ids:

- experiment evaluation every `EXPERIMENT_EVAL_INTERVAL_MIN`
- the daily report plus strategy recalibration at `DAILY_REPORT_HOUR_UTC`
- optional recurring discovery

## Policy engine and approvals

`ACTIONS` in `shared/types.ts` lists every side-effecting action with a default mode and a
**hard ceiling**:

| Action | Default | Ceiling |
|---|---|---|
| research, AI calls, opportunity writes, code generation, sandbox runs, `deploy.local`, zero-spend `experiment.start` | AUTONOMOUS | AUTONOMOUS |
| `outreach.send` | REQUIRE_APPROVAL | AUTONOMOUS (explicit opt-in; still consent-filtered and capped per day) |
| `spend.commit` | REQUIRE_APPROVAL | AUTONOMOUS (explicit opt-in; `limits.maxAmountUsd` applies) |
| `deploy.production`, `billing.configure`, `communication.mass`, `contract.sign`, `data.sensitive`, `security.policy_change`, `external.high_risk` | REQUIRE_APPROVAL | REQUIRE_APPROVAL |
| `financial.payment` / `financial.transfer` | REQUIRE_APPROVAL | REQUIRE_APPROVAL |
| `financial.trade` | SIMULATE | SIMULATE (paper ledger only) |

Modes are READ_ONLY, SIMULATE, REQUIRE_APPROVAL and AUTONOMOUS.

- `PUT /api/policies` rejects anything above the ceiling.
- Relaxing a policy is itself a `security.policy_change` and needs approval.
- Even an approved financial action is executed **only against the paper ledger**, because ROOS
  has no integration that can move money.

An approval stores: what, why, expected benefit, expected cost, risk, data sources, reversibility,
the payload, and an expiry.

## Experiment decision engine

Thresholds are registered **before** the experiment starts, which prevents moving the
goalposts:

- target rate, minimum sample, scale/kill probabilities, maximum days, budget, LTV:CAC and
  complaint rate

On each evaluation (the scheduler, `/experiment`, or `POST /api/experiments/:id/evaluate`) the
engine computes Beta posteriors per variant, P(rate > target) and P(best variant). It returns:

- **SCALE**: confident the rate is above target, and the economics (if known) pass.
- **ITERATE**: a real but ambiguous signal, or demand is fine but the economics fail.
- **PAUSE**: a guardrail was breached (complaints, CAC) or traffic is too low; needs human review.
- **KILL**: confidently below target, or time or budget ran out with a weak signal.
- **CONTINUE**: not enough evidence yet.

Each decision carries its numbers and reasons, updates the opportunity's status, raises an alert
and writes a lesson to agent memory.

## Self-improvement loop

Concluded experiments (SCALE = success, KILL = failure) become training outcomes.
`StrategyService.recalibrate` then:

1. Fits an L2-regularised logistic regression that predicts success from the scoring criteria.
2. Blends the learned weights with the prior weights (shrinkage), so a few outcomes can't swing
   the strategy.
3. Accepts the new weight set only if its Brier score beats the current one.

Every version is stored in `strategy_versions`, and opportunity scores record which weights
version produced them. Source quality is updated from how often each source's opportunities
succeed.

## MVP factory

`buildSpec` normalises a hypothesis into entities, pricing tiers and a funnel. The generator then
renders a **zero-dependency Node app** from vetted templates:

- the HTTP server, JSON-file store, validation, analytics forwarding and a payment-link stub
- a landing page with A/B variants
- the CRUD API, an OpenAPI document, `schema.sql`, and a `node:test` suite

User-controlled strings are escaped or JSON-encoded, never spliced into code. Before anything
runs, the static scanner rejects dangerous APIs.

Sandbox drivers:

- `docker`: no network, read-only root, memory/CPU/PID limits.
- `process`: Node permission model with filesystem read/write limited to the project. This is
  dev only; production refuses it.

Previews run locally. Production deploys only produce an approval request plus instructions.

## Revenue

Revenue only reaches ROOS through these paths:

- **Signature-verified Stripe webhooks**: idempotent by event id; the only source of *verified*
  revenue.
- **Read-only Stripe sync**: also verified, because the data comes from the provider.
- **Manual entries**: always *reported*, never verified.

MRR, ARR, churn, CAC, LTV, gross margin and cash burn are computed from these events. The UI
always separates verified from reported figures.

## Observability

- **Logs**: structured JSON with request ids and secret redaction.
- **Metrics**: Prometheus-format `/api/metrics` (HTTP counts and latencies, queue depth, task
  outcomes).
- **Tracing**: per-task spans for tool calls, model calls and cost.
- **Heartbeats**: workers report liveness.
- **Errors**: an optional error-webhook reporter.
- **Live updates**: the dashboard subscribes to `/api/events/stream` (SSE).
