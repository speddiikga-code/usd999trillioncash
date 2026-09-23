# Example workflows

Each workflow can be run from the dashboard command bar, the CLI (`npm run roos -- …`) or the
API (`POST /api/commands`). Watch progress live on **Agents & tasks**, or run
`npm run roos -- watch <workflowId>`.

## 1. From a hunch to a validated opportunity

```text
/research "manual invoice reconciliation for small agencies" sources=hackernews,stackexchange,github,federal_register
```

1. **ResearchAgent** searches each source, stores every document with provenance, and flags
   prompt-injection attempts.
2. It extracts pain and willingness-to-pay signals and clusters similar complaints (TF-IDF).
   With an AI provider configured, a model synthesises opportunities and must quote each
   source verbatim; unverifiable claims are dropped.
3. **RiskAgent** screens each opportunity for regulated domains (health, finance, legal,
   children…) and for manipulation attempts.
4. Each opportunity gets a transparent score: ten weighted criteria, each with a range and a
   label, plus a Monte Carlo interval.

Open an opportunity to see its evidence (quote, URL, retrieval time, confidence) and the score
breakdown. Anything the system *assumed* is labelled as an assumption.

## 2. Hypotheses → MVP → experiment

```text
/analyze opp_…
/build opp_…
/experiment opp_… budget=150 minSample=300
```

1. **MarketAgent** sizes the market as a range and assesses competition. It proposes several
   business models (e.g. SaaS, productised service, marketplace), each with unit economics:
   price, gross margin, CAC and payback as ranges.
2. **FinanceAgent** recommends a hypothesis and **CustomerAgent** drafts ICPs.
3. **ProductAgent** turns the hypothesis into a spec. **CodeAgent** generates the app (landing
   page with A/B copy, signup, CRUD API, payments stub, OpenAPI, tests). It passes the static
   scan and runs the tests in the sandbox, and **SecurityAgent** reviews the build.
4. **GrowthAgent** pre-registers the thresholds. Because `budget=150` commits spend, an
   **approval** appears showing what, why, benefit, cost, risk, data sources and reversibility.
   Nothing runs until you approve it.
5. After approval, the preview deploys locally. Its funnel events flow into ROOS automatically.

## 3. Measuring and deciding

- Share the preview (or embed the tracking snippet from **Products** in your own landing page).
  Only real visits count; bots are excluded.
- The scheduler evaluates running experiments every 15 minutes. You can also press
  **Evaluate** or call `POST /api/experiments/:id/evaluate`.
- Decisions:
  - **SCALE** raises an alert and moves the opportunity to *scaling*.
  - **KILL** stops the experiment and records a lesson.
  - **ITERATE** or **PAUSE** asks for your review.
- Every concluded experiment becomes training data. The daily recalibration adjusts the scoring
  weights only if that measurably improves prediction (Brier score).

## 4. Consent-aware outreach

```text
/growth opp_… minScore=60
```

1. **CustomerAgent** scores leads transparently: fit, intent and engagement, with the reasons
   shown.
2. **SalesAgent** drafts a campaign for leads with a lawful consent basis only (inbound, opt-in,
   existing customer, or documented legitimate interest). Every message gets an unsubscribe link
   and your postal address.
3. **Send** creates an approval. After approval, messages go out through the configured driver.
   The default is the outbox, which stores them and does not deliver. The daily cap and the
   suppression list always apply.

## 5. Revenue you can trust

1. Create a **restricted read-only** Stripe key and a webhook pointing to
   `{API_PUBLIC_URL}/api/webhooks/stripe/<workspace-slug>`.
2. Payments arrive as signature-verified events and become **verified** revenue. MRR, ARR, churn
   and LTV are computed from them.
3. Revenue entered by hand is shown as **reported**, never verified.
4. The roadmap measures progress only from verified ARR.

## 6. Portfolio and finance

```text
/finance budget=2000
```

**FinanceAgent** allocates a budget across opportunities by Thompson sampling over their
experiment evidence, with an exploration floor and a maximum share per opportunity. It also
projects cash flow as a P10/P50/P90 fan. These are recommendations only: moving money is
REQUIRE_APPROVAL at most and runs against the paper ledger.

## 7. Daily operations

- **Daily report** (every morning, or `/report`): KPIs with verified vs reported revenue,
  experiment decisions, pipeline, AI spend, failures, and recommendations that each cite
  evidence.
- **Audit** (`/audit`): verifies the hash chain and summarises security posture.
- **Status** (`/status`): health, queue, workers and pending approvals.
