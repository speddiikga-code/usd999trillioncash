# Environment variables

Configuration is read from the process environment. In development, `npm run dev` also loads
`.env`, which it creates from [`.env.example`](.env.example) on first run. The loader is
`packages/shared/src/config.ts`, which validates types and refuses unsafe production settings.

**Nothing is required in development.** Every integration is optional, and ROOS says clearly what
runs in heuristic or mock mode without it.

In production (`NODE_ENV=production`), `APP_SECRET`, `ENCRYPTION_KEY` and a reachable
`DATABASE_URL` are required. The process sandbox is also refused there.

AI provider keys, connector tokens, Stripe keys and the Resend key can also be stored **per
workspace** in the dashboard (Settings → Secrets). They are AES-256-GCM encrypted at rest and
take precedence over environment variables for that workspace.

## Core

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `production` enables strict checks, secure cookies and closed registration. |
| `LOG_LEVEL` | `info` | `debug` · `info` · `warn` · `error`. JSON logs in production. |
| `APP_SECRET` | random per process in dev | **Required in production** (≥ 32 chars). Signs HMAC tokens (unsubscribe links, IP hashes). |
| `ENCRYPTION_KEY` | random per process in dev | **Required in production.** 32 bytes as base64/hex, or a passphrase of ≥ 32 characters. Encrypts stored secrets. |
| `ENCRYPTION_KEY_PREVIOUS` | — | Set to the old key while rotating, then run `npm run admin -- rotate-secrets`. |
| `DATA_DIR` | `./data` | PGlite database, generated projects and sandbox scratch. |

> In development, missing secrets are generated **per process**. Sessions and stored secrets
> then won't survive a restart, which is why `npm run dev` writes them into `.env`.

## Database and cache

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | — | `postgres://user:pass@host:5432/db`. |
| `DB_FALLBACK` | `pglite` (dev) / `none` (prod) | Use embedded PGlite if Postgres is unreachable. |
| `PGLITE_DATA_DIR` | `$DATA_DIR/pglite` | |
| `DB_POOL_MAX` | `10` | |
| `REDIS_URL` | — | Enables distributed rate limiting. Falls back to in-memory limits per process. |

## API, auth and dashboard

| Variable | Default | Notes |
|---|---|---|
| `API_HOST` | `127.0.0.1` (dev) / `0.0.0.0` (prod) | |
| `API_PORT` | `4000` | |
| `API_PUBLIC_URL` | `http://localhost:$API_PORT` | Used in tracking snippets, unsubscribe links, webhooks and generated MVPs. |
| `APP_URL` | `http://localhost:3000` | Dashboard URL (links in reports and e-mails). |
| `TRUST_PROXY` | `false` | Set `true` behind Caddy/nginx so client IPs are correct. |
| `COOKIE_SECURE` | `true` in prod | |
| `ALLOW_REGISTRATION` | `true` in dev / `false` in prod | The very first user can always register. Later users are added by owners. |
| `SESSION_TTL_HOURS` | `168` | |
| `RATE_LIMIT_PER_MIN` | `300` | Per principal / IP. |
| `AUTH_RATE_LIMIT_PER_MIN` | `10` | Login / register per IP. |
| `TRACK_RATE_LIMIT_PER_MIN` | `600` | Public tracking per IP (×10 per write key). |
| `API_BODY_LIMIT_BYTES` | `2097152` | |
| `SEED_DEMO` | `true` | Seed the synthetic DEMO workspace on API start. |
| `DEMO_GUEST_LOGIN` | `true` in dev / `false` in prod | Password-less, read-only viewer session limited to the DEMO workspace. |
| `METRICS_TOKEN` | — | Bearer token that lets Prometheus scrape `/api/metrics` without a user session. |
| `ROOS_API_INTERNAL_URL` | `http://127.0.0.1:4000` | Dashboard → API proxy target (`next.config.mjs`). |

## Worker and scheduler

| Variable | Default | Notes |
|---|---|---|
| `EMBEDDED_WORKER` | `false` | Run the queue inside the API process. `npm run dev` sets it automatically when using PGlite. |
| `WORKER_CONCURRENCY` | `2` | Tasks per worker process. |
| `WORKER_POLL_MS` | `1000` | |
| `WORKER_ROLES` | `all` | `all`, `scheduler`, `agents`, or a comma-separated list of agent names to specialise workers. |
| `EXPERIMENT_EVAL_INTERVAL_MIN` | `15` | |
| `DAILY_REPORT_HOUR_UTC` | `7` | Daily report and strategy recalibration. |
| `DISCOVERY_INTERVAL_MIN` | `0` (off) | Recurring discovery over your configured industries. |

## AI providers (all optional)

| Variable | Default | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Default tiers: fast `claude-haiku-4-5`, balanced `claude-sonnet-5`, deep `claude-opus-5`. |
| `OPENAI_API_KEY` | — | |
| `GOOGLE_API_KEY` / `GEMINI_API_KEY` | — | |
| `OLLAMA_BASE_URL`, `OLLAMA_MODEL` | —, `llama3.1` | Local models. |
| `<PROVIDER>_MODEL_FAST` / `_BALANCED` / `_DEEP` | provider defaults | e.g. `ANTHROPIC_MODEL_DEEP`, `OPENAI_MODEL_FAST`. Verify current model names with your provider. |
| `AI_PROVIDER_ORDER` | `anthropic,openai,google,ollama` | Fallback order. `mock` is used in tests. |
| `AI_DAILY_BUDGET_USD` | `5` | Hard stop per workspace per day (also editable per workspace). |
| `AI_MAX_COST_PER_TASK_USD` | `0.5` | |
| `AI_REQUEST_TIMEOUT_MS` | `60000` | |

Without any provider, agents use deterministic heuristics and label the output as such.

## Data connectors

| Variable | Default | Notes |
|---|---|---|
| `HTTP_USER_AGENT` | generic ROOS UA | **Set a real contact.** Wikimedia and others require it. |
| `CONNECTOR_TIMEOUT_MS` | `15000` | |
| `CONNECTOR_MAX_BYTES` | `5242880` | |
| `GITHUB_TOKEN` | — | Raises GitHub search limits. |
| `STACKEXCHANGE_KEY` | — | Raises the Stack Exchange quota beyond 300 requests/day. |
| `BRAVE_SEARCH_API_KEY` | — | Enables the `brave_search` connector. |
| `SEC_USER_AGENT` | — | Enables `sec_edgar` (SEC requires a contact e-mail in the UA). |
| `CONNECTOR_ALLOW_PRIVATE_NETWORKS` | `false` | **Never in production.** Disables the SSRF private-network block. |

## Payments

| Variable | Notes |
|---|---|
| `STRIPE_SECRET_KEY` | Use a **restricted read-only** key (charges, invoices, subscriptions, customers: read). Enables `POST /api/revenue/stripe/sync`. |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…`. Webhook URL: `{API_PUBLIC_URL}/api/webhooks/stripe/<workspace-slug>`. Events: `invoice.paid`, `charge.succeeded`, `charge.refunded`, `customer.subscription.*`. |

Only these two paths produce **verified** revenue.

## E-mail

| Variable | Default | Notes |
|---|---|---|
| `EMAIL_DRIVER` | `outbox` | `outbox` stores approved messages without delivering. `resend` delivers via Resend. |
| `RESEND_API_KEY`, `EMAIL_FROM` | — | Required for `resend`. |
| `COMPANY_POSTAL_ADDRESS` | — | Required before any commercial e-mail can be sent (CAN-SPAM / PECR). It is included in every message footer. |
| `EMAIL_DAILY_CAP` | `50` | |

## Sandbox and local deployments

| Variable | Default | Notes |
|---|---|---|
| `SANDBOX_DRIVER` | `docker` | `docker` (network-isolated, required in production), `process` (dev only; Node permission model, no network isolation) or `disabled`. |
| `SANDBOX_IMAGE` | `node:24-alpine` | |
| `SANDBOX_TIMEOUT_MS` | `60000` | |
| `SANDBOX_MEMORY_MB` / `SANDBOX_CPUS` | `256` / `0.5` | |
| `PROJECTS_DIR` | `$DATA_DIR/projects` | Generated MVP source. |
| `DEPLOY_PORT_START` / `DEPLOY_PORT_END` | `5100` / `5199` | Local preview ports (bound to 127.0.0.1). |

## Observability

| Variable | Notes |
|---|---|
| `ERROR_WEBHOOK_URL` | Unhandled errors are POSTed here (JSON), e.g. a Slack or Sentry relay. |
| `METRICS_TOKEN` | See above. |

## CLI (`npm run roos`)

| Variable | Default |
|---|---|
| `ROOS_API_URL` | `http://127.0.0.1:$API_PORT` |
| `ROOS_API_KEY` | — (create in Settings → API keys, or `npm run bootstrap:admin`) |
| `ROOS_ORG_ID` | the key's organisation |

## Tests

`TEST_DATABASE_URL` runs the integration suite against a real PostgreSQL server instead of
in-memory PGlite. Point it at a **disposable server** where the user may `CREATE DATABASE`: each test
core gets its own throwaway database, dropped again when the test closes it. CI does this against
a PostgreSQL 17 service container.
