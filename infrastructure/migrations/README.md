# Migrations

The SQL migrations live with the package that owns the schema:
[`packages/database/migrations`](../../packages/database/migrations).

| File | Contents |
|---|---|
| `001_foundation.sql` | organizations, users, memberships, sessions, api_keys, secrets, policies, audit_logs (append-only, hash chain), events, alerts, the `is_demo` trigger |
| `002_research.sql` | sources, documents, markets, companies, opportunities, evidence, business_hypotheses, opportunity_scores, kg_nodes, kg_edges |
| `003_agents.sql` | agents, agent_tasks (queue), agent_memory, agent_spans (tracing), worker_heartbeats, model_calls, model_costs |
| `004_operations.sql` | projects, products, deployments, sandbox_runs, experiments, experiment_evaluations, tracking_events, metrics, customers, revenue_events, expenses, leads, campaigns, outbox_messages, suppressions, approvals, reports, paper_ledger, strategy_versions |

Migrations apply automatically when the API or worker starts (each file runs in its own
transaction under a PostgreSQL advisory lock, so concurrent starts are safe). Manually:

```bash
npm run db:migrate
npm run db:status
```

Applied migrations are checksummed; editing an applied file is reported (and refused in
production). Add a new numbered file instead.
