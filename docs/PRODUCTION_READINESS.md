# Production readiness

This page is an honest statement of what is real, what is simulated, and what must happen
before ROOS runs real businesses with real money.

## Real vs simulated

| Capability | Status |
|---|---|
| Public-data discovery (HN, Stack Exchange, GitHub, Federal Register, npm, Wikipedia, Remotive, RSS, web pages) | **Real.** Live HTTP requests with provenance. Brave and SEC EDGAR are real once configured. |
| Opportunity synthesis without an AI key | **Real heuristics.** Deterministic text analysis, labelled as heuristic, MODEL_ASSUMPTION or ESTIMATED. |
| Opportunity synthesis with an AI key | **Real model calls**, constrained to verbatim-quoted evidence. Quality depends on the model. |
| Market size, pricing, CAC and other estimates | **Estimates and assumptions**, always labelled and ranged. They are not market research. |
| MVP generation, static scan, sandbox tests | **Real.** Runnable apps, real test execution. |
| Local preview deployment | **Real** (localhost only). |
| Production deployment of generated MVPs | **Approval plus instructions only.** ROOS does not push to a hosting provider. |
| Tracking and experiment decisions | **Real** once real traffic arrives. Decisions are statistical, not guarantees. |
| Verified revenue | **Real** only via Stripe (signature-verified webhooks or read-only sync). |
| Manual revenue | Stored as **reported** (USER_INPUT), never verified. |
| Email outreach | **Outbox only** by default. Real delivery requires `EMAIL_DRIVER=resend`, a verified domain, a postal address, and approval. |
| Payments, transfers, trades | **Simulated** (paper ledger). No integration can move money. |
| Portfolio allocation and cash-flow projections | **Real computations on your data**, output as recommendations. |
| Quadrillion roadmap | **A model of what would have to be true.** It is not a forecast or promise. |
| DEMO workspace | **Synthetic.** Labelled everywhere and isolated from real data by the database. |

## Limitations

- **Evidence is only as good as its sources.** Public forums over-represent developers and
  vocal users, so pain signals are a starting point, not proof of demand. The experiment engine
  exists to test them against real behaviour.
- **Heuristic mode is coarse.** Without an AI provider, clustering and hypotheses are
  template-based. They are useful for triage, not for final decisions.
- **Generated MVPs are validation vehicles**: a landing page, signup, simple CRUD and a
  payment-link stub, with a JSON-file store. They are not production SaaS.
- **Statistics need traffic.** Below the pre-registered minimum sample, the engine answers
  CONTINUE. It will not decide early.
- **Market sizing** comes from mention counts and rough ARPU assumptions. Treat it as an order
  of magnitude.
- **The process sandbox** (development) has no network isolation.
- **Basic account features only.** Multi-organisation and RBAC work, but there is no MFA, SSO,
  SCIM, email verification or self-service password reset yet.
- **Embedded PGlite** is single-process and for development only.

## Blockers before production use

1. **Sandbox infrastructure.** Run the Docker sandbox on an isolated host or a VM-isolated
   runtime, and add the Docker CLI to the worker image. Until then keep
   `SANDBOX_DRIVER=disabled` in production (code is generated and scanned, not run).
2. **Account security.** Add MFA (TOTP/WebAuthn), email verification and password reset, and
   optionally SSO.
3. **Secrets management.** Load `APP_SECRET` / `ENCRYPTION_KEY` from a secret manager (not
   `.env` files) and document a rotation runbook.
4. **Backups and disaster recovery.** Automated Postgres backups with tested restores, and PITR.
5. **Legal review** of outreach templates, data retention, privacy policy and cookie consent
   for tracked pages (GDPR/CCPA), plus the regulated-domain screens.
6. **Email deliverability.** Verified sending domain (SPF/DKIM/DMARC) and bounce/complaint
   webhooks feeding suppressions. Complaint events can currently be sent to `/api/track`.
7. **Observability.** Wire `/api/metrics` into Prometheus/Grafana with alerts on failed tasks,
   queue depth, AI spend and worker heartbeats. Route `ERROR_WEBHOOK_URL` to on-call.
8. **Load and soak testing** of the API and workers against managed Postgres. Tune
   `DB_POOL_MAX` and `WORKER_CONCURRENCY`.
9. **Dependency and image hygiene.** Run `npm run audit:deps` in CI, rebuild images on base
   updates, and pin image digests.
10. **Verify model names and prices.** Model defaults and `model_costs` prices are configurable;
    confirm them against your providers before relying on the budget guard's cost estimates.

## Next highest-value engineering tasks

1. **A real hosting integration for approved production deploys** (e.g. Fly.io, Render or a
   container registry plus a VM) that runs only after approval. Include a teardown path.
2. **Bounce/complaint webhooks** (Resend) → suppressions and experiment guardrails.
3. **More payment providers** for verified revenue (Paddle, Lemon Squeezy), using the same
   verified-only rule.
4. **Richer generated MVPs**: Postgres storage, auth, and a Stripe Checkout integration
   (behind `billing.configure` approval).
5. **Evaluation harness for AI synthesis**: labelled opportunities → precision of evidence-backed
   claims, so model or prompt changes are measured rather than guessed.
6. **Source-quality learning in discovery ranking.** The weights are already stored; feed them
   into query planning.
7. **MFA and email verification** (see blockers).
8. **CI pipeline** (typecheck, tests, dependency audit, Docker build) and preview environments.
