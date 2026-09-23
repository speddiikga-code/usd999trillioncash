# Setup

## 1. Prerequisites

| Requirement | Notes |
|---|---|
| Node.js ≥ 22.12 (24 recommended) | Needed for `process.loadEnvFile` and the Node permission model used by the dev sandbox. |
| Docker (optional) | Runs PostgreSQL + Redis locally and the strongest code sandbox. Without it ROOS uses embedded PGlite and the process sandbox. |

Windows, macOS and Linux are supported. On Windows without admin rights you can unzip the
official portable Node build and put it on your `PATH`.

## 2. Install and run

```bash
docker compose up -d        # optional: PostgreSQL 17 on :5432, Redis 7 on :6379
npm install
npm run dev
```

`npm run dev` (implemented in [`scripts/dev.mjs`](scripts/dev.mjs)) does the following:

1. Creates `.env` from `.env.example` if it is missing, filling `APP_SECRET` and
   `ENCRYPTION_KEY` with random values. If Docker isn't installed it also sets
   `SANDBOX_DRIVER=process`.
2. Checks whether `DATABASE_URL` is reachable.
   - **Reachable:** starts the API (:4000), a separate worker process and the dashboard (:3000).
   - **Not reachable:** starts the API on embedded **PGlite** (`./data/pglite`) with the worker
     running inside the API process, plus the dashboard.
3. On first start, the API applies migrations and seeds the DEMO workspace. Set
   `SEED_DEMO=false` to skip the seed.

Open <http://localhost:3000>.

### Other commands

```bash
npm run dev:api | dev:worker | dev:dashboard    # run one service
npm run db:migrate / db:status                  # migrations (also applied automatically on start)
npm run db:seed-demo -- --reset                 # recreate the DEMO workspace
npm run bootstrap:admin -- you@example.com 'a long password' "Your Name"   # prints an owner API key
npm run admin -- verify-audit <orgId>           # verify the audit hash chain
npm run admin -- rotate-secrets                 # re-encrypt stored secrets after rotating ENCRYPTION_KEY
npm run roos -- /status                         # CLI (needs ROOS_API_KEY)
npm run typecheck && npm test                   # all checks
npm run build                                   # production dashboard build
docker compose --profile app up --build         # whole stack in containers
```

> With embedded PGlite only one process may open the database. Stop `npm run dev` before
> running `npm run admin …`, `db:*` or `bootstrap:admin`.

## 3. First-run experience (11 steps)

The **Getting started** page (`/onboarding`) tracks these steps. Each one is marked done
automatically when the underlying action happens.

1. **System status**: database, queue, worker heartbeat, sandbox driver and integrations.
2. **Connect AI** (optional): add a provider key in Settings, where it is encrypted at rest.
   Without a key, agents use labelled heuristics.
3. **Configure sources**: enable or disable connectors, add RSS feeds and web pages, or upload a
   CSV/JSON dataset.
4. **Constraints**: starting capital, monthly budget, hours per week and risk tolerance.
5. **Industries** of interest, plus exclusions.
6. **First scan**: `/research "…"`. Watch it live on **Agents & tasks**.
7. **Hypotheses**: `/analyze <id>` produces several business models with unit economics.
8. **Select an opportunity** and a hypothesis.
9. **Generate the MVP**: `/build <id>`. The app is generated, tested in the sandbox and
   security-reviewed.
10. **Launch an experiment**: `/experiment <id> budget=…`. Any spend needs your approval, after
    which a local preview is deployed.
11. **Track results**: embed the tracking snippet (or use the generated MVP). The experiment
    engine evaluates results every 15 minutes, and daily reports summarise what happened.

## 4. Connecting real services

See [ENVIRONMENT.md](ENVIRONMENT.md) for every variable. The ones most worth setting:

| Goal | Set |
|---|---|
| Better synthesis (claims must quote their sources verbatim) | `ANTHROPIC_API_KEY` (or OpenAI / Gemini / Ollama) — or add it in Settings → AI providers |
| Verified revenue | `STRIPE_SECRET_KEY` (restricted, read-only) + `STRIPE_WEBHOOK_SECRET`; point a Stripe webhook at `{API_PUBLIC_URL}/api/webhooks/stripe/<workspace-slug>` |
| Deliver approved emails | `EMAIL_DRIVER=resend`, `RESEND_API_KEY`, `EMAIL_FROM`, `COMPANY_POSTAL_ADDRESS` |
| Higher API limits | `GITHUB_TOKEN`, `STACKEXCHANGE_KEY` |
| More sources | `BRAVE_SEARCH_API_KEY`, `SEC_USER_AGENT` (contact e-mail, required by SEC) |

## 5. Troubleshooting

| Symptom | Fix |
|---|---|
| `APP_SECRET and ENCRYPTION_KEY are required in production` | Set both, e.g. `openssl rand -base64 32`. |
| Dashboard shows "You don't have permission…" | Your role lacks that permission (e.g. viewers can't see leads). Ask an owner/admin. |
| `/build` fails with sandbox errors | Check `SANDBOX_DRIVER`. `docker` needs a running Docker daemon; `process` needs Node ≥ 22. |
| Port 3000/4000 already in use | Stop the old process, or change `API_PORT` / the dashboard port. |
| Discovery returns little | Public APIs rate-limit anonymous use; add `GITHUB_TOKEN` / `STACKEXCHANGE_KEY`, or narrow the query. |
| `PGlite` lock errors | Another process holds `./data/pglite`; stop it first. |
| Reset everything locally | Stop ROOS, delete `./data` (PGlite + generated projects), start again. |
