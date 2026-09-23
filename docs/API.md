# REST API

Base URL: `http://localhost:4000` (or `API_PUBLIC_URL`). All bodies are JSON. Errors look like:

```json
{ "error": { "code": "VALIDATION", "message": "…", "details": { "fields": { "email": "…" } } } }
```

## Authentication

| Method | Use | Headers |
|---|---|---|
| **API key** | Scripts, CLI, integrations | `Authorization: Bearer roos_…` (scoped to one workspace + role) |
| **Session cookie** | Dashboard | `roos_session` cookie + `x-csrf-token` on writes + `x-org-id` |
| **Write key** | Public tracking only | `x-roos-write-key: pk_…` |
| **Stripe signature** | Webhooks only | `Stripe-Signature` |

Create an API key in **Settings → API keys**, with `POST /api/api-keys`, or with
`npm run bootstrap:admin`.

```bash
export ROOS=http://localhost:4000
export KEY=roos_xxxxxxxxxxxxxxxx
alias roos='curl -sS -H "Authorization: Bearer $KEY" -H "content-type: application/json"'
```

## Auth and workspace

```bash
curl -s $ROOS/api/auth/state
# → {"hasUsers":true,"allowRegistration":false,"authenticated":false,"demoGuestLogin":true}

curl -s -c jar -X POST $ROOS/api/auth/register -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"a long passphrase","name":"You","orgName":"My Co"}'
# → {"user":{…},"orgId":"org_…","csrfToken":"…"}   (session cookie in ./jar)

curl -s -b jar -X POST $ROOS/api/api-keys -H 'content-type: application/json' \
  -H "x-csrf-token: <csrfToken>" -H "x-org-id: <orgId>" -d '{"name":"cli","role":"operator"}'
# → {"id":"key_…","key":"roos_…","role":"operator"}   (shown once)

roos $ROOS/api/org
roos -X PATCH $ROOS/api/org -d '{"constraints":{"initialCapitalUsd":2000,"monthlyBudgetUsd":300,"hoursPerWeek":10,"riskTolerance":"low"},"industries":["finance operations"]}'
```

## Commands (the command center)

```bash
roos -X POST $ROOS/api/commands -d '{"command":"/research \"find underserved B2B AI opportunities\" sources=hackernews,github"}'
# → 202 {"command":"research","workflowId":"wf_…","tasks":[{"id":"task_…","agent":"ResearchAgent","kind":"research.discover"}]}

roos $ROOS/api/workflows/wf_…          # all tasks in the workflow, with status/output/errors
roos -X POST $ROOS/api/commands -d '{"command":"/status"}'   # synchronous
```

| Command | What happens |
|---|---|
| `/research "<query>" [sources=a,b] [limit=30]` | ResearchAgent → RiskAgent screening |
| `/analyze <oppId>` | MarketAgent → RiskAgent → FinanceAgent → CustomerAgent; multiple hypotheses, best selected |
| `/build <oppId> [hypothesis=<id>]` | ProductAgent spec → CodeAgent generate + sandbox tests → SecurityAgent review |
| `/launch <projectId> [production=true]` | Local preview (autonomous); production is always an approval request |
| `/experiment <oppId> [budget=100] [minSample=200]` | GrowthAgent designs + starts (spend → approval) → preview deployed |
| `/growth <oppId> [minScore=50]` | CustomerAgent scores leads → SalesAgent drafts a consent-aware campaign (not sent) |
| `/finance [budget=1000]` | FinanceAgent allocation + cash-flow projection (recommendations only) |
| `/audit` | SecurityAgent: audit-chain verification + posture |
| `/report` | AnalyticsAgent daily report |
| `/status` | Health, KPIs, pending approvals (synchronous) |

## Opportunities and research

```bash
# Inline discovery (waits for results). Without "wait" it's queued as a workflow (202).
roos -X POST $ROOS/api/opportunities/discover -d '{"query":"invoice reconciliation","sources":["hackernews","stackexchange","federal_register"],"limitPerSource":20,"wait":true}'

roos "$ROOS/api/opportunities?sort=score&minScore=0.5&limit=20"
roos $ROOS/api/opportunities/opp_…            # detail: evidence (with provenance), hypotheses, score breakdown, experiments
roos $ROOS/api/opportunities/opp_…/graph      # knowledge-graph neighbourhood
roos -X POST $ROOS/api/opportunities/opp_…/hypotheses/select -d '{"hypothesisId":"hyp_…"}'
roos -X PATCH $ROOS/api/opportunities/opp_… -d '{"status":"paused"}'

roos $ROOS/api/sources
roos -X POST $ROOS/api/sources -d '{"connector":"rss","name":"Indie Hackers","config":{"urls":["https://example.com/feed.xml"]}}'
# CSV columns: title,text,url,date,points — stored as USER_INPUT evidence
roos -X POST $ROOS/api/sources/dataset -d '{"name":"survey-2026","csv":"title,text\nInvoices,We waste hours reconciling invoices…"}'
```

An evidence item looks like this. Every claim has a kind, a confidence and provenance:

```json
{
  "kind": "OBSERVED", "confidence": 0.72,
  "quote": "We spend two days every month reconciling invoices by hand",
  "sourceUrl": "https://news.ycombinator.com/item?id=…",
  "provenance": { "connector": "hackernews", "retrievedAt": "2026-09-23T10:02:11Z", "injectionScore": 0 }
}
```

## Products, projects and deployments

```bash
roos $ROOS/api/projects                        # generated MVPs (status: generated | tests_passed | tests_failed | scan_failed | deployed)
roos "$ROOS/api/projects/prj_…/file?path=server.js"
roos -X POST $ROOS/api/projects/prj_…/deploy   # local preview (policy deploy.local)
roos -X POST $ROOS/api/projects/prj_…/production   # creates an approval; never deploys directly
roos $ROOS/api/deployments
roos -X POST $ROOS/api/deployments/dep_…/stop
roos $ROOS/api/products/prd_…                  # includes writeKey, trackUrl and 30-day funnel
```

## Experiments

```bash
roos -X POST $ROOS/api/experiments -d '{"opportunityId":"opp_…","budgetUsd":100,"variants":["a","b"],"funnel":"landing_signup","thresholds":{"targetRate":0.05,"minSample":200,"maxDays":21}}'
roos -X POST $ROOS/api/experiments/exp_…/start      # → {"status":"running"} or {"status":"pending_approval","approvalId":"apr_…"}
roos $ROOS/api/experiments/exp_…                    # funnel stages, per-variant posteriors, evaluations
roos -X POST $ROOS/api/experiments/exp_…/evaluate   # → {"decision":"SCALE|ITERATE|PAUSE|KILL|CONTINUE","reasons":[…],"stats":{…}}
roos -X POST $ROOS/api/experiments/exp_…/spend -d '{"amountUsd":40,"description":"Reddit ads"}'
roos -X POST $ROOS/api/experiments/exp_…/stop
```

### Public tracking (from any landing page)

```bash
curl -X POST $ROOS/api/track -H 'content-type: application/json' -H 'x-roos-write-key: pk_…' \
  -d '{"event":"signup","anonymousId":"a-123","experimentId":"exp_…","variant":"b","email":"lead@example.com"}'
```

Events: `page_view`, `cta_click`, `signup`, `activation`, `demo_requested`, `checkout_started`,
`payment`, `referral`, `unsubscribe`, `complaint`, `custom`. Bots are flagged and excluded. Signups with an
email become **inbound** (consented) leads. Generated MVPs send these events automatically.

## Approvals

```bash
roos "$ROOS/api/approvals?status=pending"
# → [{"id":"apr_…","actionType":"spend.commit","what":"…","why":"…","expectedBenefit":"…",
#     "expectedCostUsd":100,"risk":{"level":"medium","description":"…"},
#     "dataSources":[…],"reversibility":"partially_reversible","expiresAt":"…"}]
roos -X POST $ROOS/api/approvals/apr_…/approve -d '{"note":"ok, cap at $100"}'
roos -X POST $ROOS/api/approvals/apr_…/reject  -d '{"note":"not now"}'
```

## Leads and campaigns

```bash
roos -X POST $ROOS/api/leads -d '{"name":"Ada","email":"ada@example.com","company":"Acme","consentBasis":"opt_in"}'
roos -X POST $ROOS/api/leads/import -d '{"csv":"name,email,company\nAda,ada@example.com,Acme","defaultConsentBasis":"unknown"}'
roos $ROOS/api/pipeline
roos -X POST $ROOS/api/campaigns -d '{"name":"Early access","opportunityId":"opp_…","subjectTemplate":"{{first_name}}, quick question","bodyTemplate":"Hi {{first_name}}, …"}'
roos -X POST $ROOS/api/campaigns/cmpgn_…/send       # → pending_approval (default policy)
```

Leads with `consentBasis: "unknown"` are never drafted to. Every message gets an unsubscribe
link and your postal address. With `EMAIL_DRIVER=outbox` (the default), approved messages are
stored but **not delivered**.

## Revenue, finance and roadmap

```bash
roos $ROOS/api/revenue            # {"verified":{…},"reported":{…},"note":"…"} — MRR, ARR, churn, CAC, LTV, margin, burn
roos -X POST $ROOS/api/revenue/events -d '{"type":"charge","amountUsd":300,"description":"bank transfer"}'   # reported, never verified
roos -X POST $ROOS/api/revenue/stripe/sync       # read-only pull → verified
roos "$ROOS/api/revenue/cashflow?months=18"      # P10/P50/P90 fan
roos -X POST $ROOS/api/expenses -d '{"category":"ads","amountUsd":40,"description":"Reddit ads"}'
roos $ROOS/api/portfolio
roos -X POST $ROOS/api/portfolio/allocate -d '{"budgetUsd":1000,"maxShare":0.5}'
roos $ROOS/api/roadmap                           # required CAGR, scenarios, feasibility, empirical progress
roos -X POST $ROOS/api/roadmap/preview -d '{"horizonYears":40,"startingArrUsd":100000}'
roos $ROOS/api/ledger                            # paper ledger (simulated financial actions)
```

### Stripe webhook

Point Stripe at `POST {API_PUBLIC_URL}/api/webhooks/stripe/<workspace-slug>`. The signature is
verified with `STRIPE_WEBHOOK_SECRET` (or the workspace secret). Replays are ignored by event id.

## Agents, tasks, system

```bash
roos $ROOS/api/agents                 # definitions, allow-lists, budgets, today's spend
roos -X PATCH $ROOS/api/agents/ResearchAgent -d '{"enabled":false}'
roos "$ROOS/api/tasks?status=failed"
roos $ROOS/api/tasks/task_…            # input, output, error, spans (tool + model calls, cost)
roos -X POST $ROOS/api/tasks/task_…/retry
roos $ROOS/api/system/status          # db, queue, workers, sandbox, integrations
roos $ROOS/api/graph                  # knowledge graph
roos -X POST $ROOS/api/reports/generate
roos $ROOS/api/recommendations
roos "$ROOS/api/audit?action=approval"
roos $ROOS/api/audit/verify           # {"valid":true,"entries":1234}
roos $ROOS/api/policies
roos -X PUT $ROOS/api/policies -d '{"action":"spend.commit","mode":"REQUIRE_APPROVAL","limits":{"maxAmountUsd":200}}'
roos -X PUT $ROOS/api/secrets -d '{"name":"ai.anthropic.api_key","value":"sk-ant-…"}'
roos $ROOS/api/ai/usage
curl -N -H "Authorization: Bearer $KEY" $ROOS/api/events/stream     # server-sent events
curl -H "Authorization: Bearer $METRICS_TOKEN" $ROOS/api/metrics     # Prometheus
curl $ROOS/api/health
```

## Endpoint index

| Method | Path | Permission |
|---|---|---|
| GET | `/api/health` | public |
| GET | `/api/auth/state` · POST `/api/auth/register` · `/login` · `/logout` · `/demo` · GET `/api/auth/me` | public / session |
| GET/POST/DELETE | `/api/api-keys[/:id]` | settings:read / settings:write |
| GET/POST | `/api/members` | org:read / members:manage |
| GET/PATCH | `/api/org` · POST `/api/onboarding/step` | org:read / org:write |
| POST | `/api/demo/seed` | settings:write |
| POST | `/api/opportunities/discover` | research:run |
| GET/POST | `/api/opportunities` · GET/PATCH `/api/opportunities/:id` · POST `/:id/hypotheses/select` · GET `/:id/graph` | opportunity:read / write |
| GET/POST/PATCH | `/api/sources[/:id]` · POST `/api/sources/dataset` | org:read / settings:write |
| GET/POST | `/api/experiments` · GET `/:id` · POST `/:id/start` `/evaluate` `/stop` `/spend` | experiment:read / write (spend: revenue:write) |
| GET/POST | `/api/products[/:id]` · GET `/api/projects[/:id]` `/:id/file` | opportunity:read / write |
| POST | `/api/projects/:id/deploy` · `/production` · GET `/api/deployments` · POST `/:id/stop` | deploy:run |
| GET/POST/PATCH | `/api/leads[/:id]` · POST `/import` · GET `/export` · GET `/api/pipeline` | lead:read / write / export |
| GET/POST | `/api/campaigns[/:id]` · POST `/:id/send` | lead:read / campaign:write |
| GET/POST | `/api/revenue` · `/events` · POST `/stripe/sync` · GET `/cashflow` · `/api/expenses` · `/api/ledger` | revenue:read / write |
| GET/POST | `/api/portfolio` · `/allocate` · `/api/roadmap` · POST `/preview` · PUT `/assumptions` | revenue:read (assumptions: org:write) |
| GET/PATCH | `/api/agents[/:name]` · GET `/api/tasks[/:id]` · POST `/:id/cancel` `/retry` · GET `/api/workflows/:id` | agent:read / manage / run |
| POST | `/api/commands` | per-command (see `COMMAND_PERMISSIONS`) |
| GET/POST | `/api/approvals[/:id]` · POST `/:id/approve` `/reject` | approval:read / decide |
| GET | `/api/audit` · `/api/audit/verify` | audit:read |
| GET/POST | `/api/reports[/:id]` · POST `/generate` · GET `/api/recommendations` | report:read |
| GET | `/api/graph` · `/api/graph/nodes/:id` | opportunity:read |
| GET/POST | `/api/alerts` · POST `/:id/ack` | org:read |
| GET/PUT | `/api/policies` | settings:read / policy:write |
| GET/PUT/DELETE | `/api/secrets[/:name]` | settings:read / secrets:write |
| GET/PUT | `/api/ai/providers` · `/usage` · `/pricing` · GET `/api/integrations` | settings:read / write |
| GET | `/api/system/status` · `/api/events` · `/api/events/stream` | org:read |
| GET | `/api/metrics` | settings:read or `METRICS_TOKEN` |
| POST | `/api/track` | product write key |
| POST | `/api/webhooks/stripe/:orgSlug` | Stripe signature |
| GET | `/api/public/unsubscribe` | HMAC token |
