# ROOS — Revenue Opportunity Operating System

[![CI](https://github.com/speddiikga-code/usd999trillioncash/actions/workflows/ci.yml/badge.svg)](https://github.com/speddiikga-code/usd999trillioncash/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

ROOS finds, validates, launches, measures and scales **legitimate** businesses. It gathers public
evidence of real problems and scores each opportunity transparently. It then generates several
business hypotheses, builds a runnable MVP, and runs a pre-registered experiment on it. The
experiment's outcome decides **SCALE / ITERATE / PAUSE / KILL**, and the results feed back into
the scoring model.

It is deliberately *not* an "AI money machine":

- **Every figure carries a label**: **OBSERVED** (from a source, with a URL and a retrieval
  time), **ESTIMATED** (derived, with a range), **MODEL_ASSUMPTION**, **USER_INPUT** or **DEMO**.
  Nothing is presented as more certain than it is.
- **Revenue is "verified" only when it comes from signature-checked payment-provider events.**
  The database enforces this with CHECK constraints. Manual entries stay "reported".
- **No autonomous spam or spending.** Outreach, spend, production deploys and every financial
  action pass through an approval gate. Each approval shows *what, why, benefit, cost, risk, data
  sources and reversibility*.
  - Money can never move autonomously: payments are capped at `REQUIRE_APPROVAL`, trades at
    `SIMULATE` (paper ledger only).
- **The $9,999,000,000,000,000 target is an optimisation objective, not a forecast.** The roadmap
  page shows what would *have* to be true (required CAGR, customers vs. world population, share
  of world GDP). It also tracks empirical progress from verified revenue only.

## Quick start

Requirements: **Node.js ≥ 22.12** (tested on 24). Docker is optional.

```bash
docker compose up -d      # PostgreSQL 17 + Redis 7 (optional — see below)
npm install
npm run dev               # API :4000 · worker · dashboard :3000
```

Open <http://localhost:3000>. On first start, `npm run dev`:

- creates `.env` from `.env.example` and generates `APP_SECRET` / `ENCRYPTION_KEY`
- applies the database migrations
- seeds a **clearly labelled DEMO workspace**

The first account you register becomes the owner. To look around first, use **"Explore the demo
workspace"** on the login page, which opens a read-only session.

**No Docker?** If PostgreSQL isn't reachable, `npm run dev` falls back to **embedded PGlite**
(Postgres compiled to WASM, stored in `./data/pglite`). It runs the worker inside the API
process. Generated MVPs are then tested with Node's permission-model sandbox
(`SANDBOX_DRIVER=process`, development only).

Try it from the command bar (or `npm run roos -- <command>` with an API key):

```text
/research "find underserved B2B AI opportunities"
/analyze <opportunity-id>
/build <opportunity-id>
/experiment <opportunity-id> budget=100
/status
```

## What works without any credentials

Everything in the core loop:

- **Discovery** from free public sources: Hacker News, Stack Exchange, GitHub issues, the US
  Federal Register, npm, Wikipedia pageviews, Remotive jobs, RSS and robots.txt-aware web
  pages. Sources are rate-limited and cached.
- **Heuristic synthesis** of opportunities, business hypotheses, unit economics, risk screening
  and lead scoring. Every result is labelled as a heuristic, a MODEL_ASSUMPTION or an ESTIMATE.
- **The MVP factory**: generated apps, sandbox tests, a security scan and local preview
  deployment.
- **Experiments**: the tracking API, Bayesian decisions and portfolio allocation (Thompson
  sampling).
- **Finance views**: cash-flow fan charts, the roadmap, daily reports and the knowledge graph.
- **Operations**: the audit log, approvals, the agents and the paper ledger.

Credentials only unlock more. AI providers improve synthesis quality. Stripe provides *verified*
revenue. Resend makes approved emails actually deliver (by default they go to an outbox). Brave
and SEC EDGAR add data sources. See [ENVIRONMENT.md](ENVIRONMENT.md).

## Documentation

| | |
|---|---|
| [SETUP.md](SETUP.md) | Installation, commands, first-run walkthrough, troubleshooting |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Packages, data model, agents, queue, decision engine, data flow |
| [SECURITY.md](SECURITY.md) | Threat model, controls, financial permission model |
| [ENVIRONMENT.md](ENVIRONMENT.md) | Every environment variable |
| [docs/API.md](docs/API.md) | REST API with curl examples |
| [docs/WORKFLOWS.md](docs/WORKFLOWS.md) | End-to-end example workflows |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Production deployment |
| [docs/PRODUCTION_READINESS.md](docs/PRODUCTION_READINESS.md) | What is simulated vs real, limitations, blockers |

## Repository layout

```text
apps/
  api/          Fastify REST API + SSE (+ optional embedded worker)
  worker/       Agent queue workers and scheduler
  dashboard/    Next.js operations dashboard
  cli/          HTTP command-line client (npm run roos)
packages/
  shared/       Types, provenance, config, schemas, ids, logger
  database/     Postgres/PGlite client, migrations, transactions
  security/     Passwords, AES-GCM secrets, RBAC, SSRF guard, rate limits, injection scanning
  ai/           Provider-agnostic model router (Anthropic, OpenAI, Gemini, Ollama, mock)
  connectors/   Public-data connectors with provenance, caching and politeness
  analytics/    Statistics, scoring, experiments, portfolio, roadmap, projections, learning
  billing/      Stripe webhook verification and read-only client
  factory/      MVP generator, sandbox runner, local deployer
  core/         Domain services (opportunities, experiments, revenue, approvals, audit…)
  agents/       11 agents, orchestrator, command center, scheduler
infrastructure/ Dockerfile, production compose + Caddy, migrations notes
tests/          End-to-end test over real HTTP
```

## Checks

```bash
npm run typecheck        # TypeScript across all packages
npm test                 # unit + integration + end-to-end (no Docker or network needed)
npm run build            # typecheck + production dashboard build
```

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs on every push to `main` and every pull request:

- typecheck and the full test suite on Linux (Node 22 and 24) and on Windows
- the integration tests against a real PostgreSQL 17 server
- the dashboard production build and a dependency audit
- builds of the api, worker and dashboard Docker images

## License

[MIT](LICENSE): free to use, modify and distribute, including commercially.
