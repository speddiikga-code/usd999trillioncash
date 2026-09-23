# Security

## Principles

1. **Least privilege for automation.** Agents may call only the tools on their allow-list, and
   every side-effecting tool call is also checked by the policy engine.
2. **Humans approve anything irreversible, public or financial.** Money can never move
   autonomously. ROOS has no integration capable of initiating a payment, transfer or trade:
   financial actions execute only against a paper ledger, even after approval.
3. **Untrusted input stays data.** Web pages, documents, model output and generated code are
   never treated as instructions or trusted code.
4. **Honest data.** Labels (OBSERVED / ESTIMATED / MODEL_ASSUMPTION / USER_INPUT / DEMO) and the
   verified-revenue rule are enforced in code *and* by database constraints.

## Controls

| Area | Implementation |
|---|---|
| Passwords | scrypt (N=2¹⁵, r=8, p=1), unique salt, constant-time compare. Minimum 12 characters. Lockout after repeated failures. |
| Sessions | Random tokens, stored hashed. `HttpOnly`, `SameSite=Lax`, `Secure` when `COOKIE_SECURE=true`. Server-side expiry and logout revocation. |
| CSRF | Double-submit token (`x-csrf-token`) required on every cookie-authenticated write. API-key requests are exempt (no ambient credentials). |
| API keys | `roos_…` Bearer tokens. Only the SHA-256 hash is stored; the key is shown once. Scoped to one organisation and a role. Revocable. |
| RBAC | Roles owner / admin / operator / analyst / viewer, with a fixed permission matrix (`security/rbac.ts`). Enforced on every route. Nobody can grant a role above their own. |
| Multi-tenancy | Every query is scoped by `org_id`; the organisation is resolved from membership, never from the request alone. Demo data is isolated by a DB trigger. |
| Secrets at rest | AES-256-GCM with the org id as associated data, so a ciphertext can't be moved between tenants. `ENCRYPTION_KEY_PREVIOUS` + `npm run admin -- rotate-secrets` rotates keys. Secrets are never returned by the API, only whether they are set. |
| Secrets in code | None hard-coded. Production refuses to start without `APP_SECRET` / `ENCRYPTION_KEY`. Logs redact sensitive keys recursively. |
| Rate limiting | Per-IP and per-principal limits (Redis when available, memory otherwise). Stricter limits on auth; separate limits for tracking per IP and per write key. |
| Input validation | Zod schemas on every body. Body size limit. Parameterised SQL only. JSON 404/400s with field errors. |
| Output encoding | JSON API. HTML escaping in generated apps and server-rendered pages. Strict CSP (`default-src 'none'` on the API, a locked-down CSP and `frame-ancestors 'none'` on the dashboard). `nosniff`, `Referrer-Policy`, HSTS behind Caddy. |
| SSRF | All outbound fetches go through `safeFetch`: http(s) only; private, loopback, link-local and reserved IPv4/IPv6 blocked; checked at DNS resolution (rebinding-safe); every redirect re-validated; size and time limits. `CONNECTOR_ALLOW_PRIVATE_NETWORKS` exists for development only. |
| Prompt injection | Documents are scanned (instruction overrides, role play, exfiltration, hidden text). Untrusted text is fenced with a random boundary and the model is told it is data. Suspicious evidence is down-weighted. Model claims must quote the cited source verbatim or they are dropped. Agents can't reach tools outside their allow-list whatever a model says. |
| Code execution | Generated code comes from vetted templates, and user strings are escaped or JSON-encoded, never interpolated. A static scanner blocks `child_process`, `eval`, `new Function`, `vm` and similar. Code runs in a sandbox: Docker with `--network none`, read-only root and memory/CPU/PID limits; or, in development, Node's permission model. Production refuses the process driver. |
| Webhooks | Stripe signatures verified (HMAC-SHA256 over the raw body, timestamp tolerance, constant-time compare). Idempotent by event id. |
| Tracking | Public write keys (`pk_…`) can only append funnel events for their own product. Bots are flagged and excluded. IPs are stored as keyed hashes. |
| Outreach | Leads carry a consent basis. Unknown-consent leads are never drafted to. Suppression list, HMAC unsubscribe links, postal-address requirement, daily cap. Sending needs approval unless an owner opts into an automation policy (itself an approval-gated policy change). Default email driver is an outbox that never delivers. |
| Audit | Every significant action is written to `audit_logs`, which is append-only (DB trigger) and hash-chained. `GET /api/audit/verify` or `npm run admin -- verify-audit <orgId>` detects tampering. |
| Dependencies | Few runtime dependencies. `npm run audit:deps` fails on high-severity advisories. Generated MVPs have zero dependencies. |

## Financial permission model

| Mode | Meaning |
|---|---|
| READ_ONLY | The action is blocked. |
| SIMULATE | Recorded on the paper ledger only. |
| REQUIRE_APPROVAL | Creates an approval request (what / why / benefit / cost / risk / data sources / reversibility). |
| AUTONOMOUS | Allowed within limits, and only for actions whose ceiling permits it. |

Ceilings:

- `financial.payment` and `financial.transfer` are capped at **REQUIRE_APPROVAL**.
- `financial.trade` is capped at **SIMULATE** (paper trading).
- `billing.configure`, `contract.sign` and `deploy.production` are capped at REQUIRE_APPROVAL.

The ceilings live in code, so they can't be raised through the API. Relaxing any policy creates
an approval of its own.

Stripe access is designed for a **restricted, read-only key**. The one Stripe write ROOS can
perform, creating a payment link, is gated by `billing.configure`.

## Reporting a vulnerability

Please report vulnerabilities privately to the repository owner rather than in a public issue.
Include reproduction steps and the affected version. We aim to acknowledge reports within 3
business days.

## Known limitations

See [docs/PRODUCTION_READINESS.md](docs/PRODUCTION_READINESS.md). In short:

- The `process` sandbox has no network isolation (dev only).
- There is no MFA or SSO yet.
- The Docker sandbox needs the host's Docker socket, which is root-equivalent; run it on an
  isolated host.
- In-memory rate limits are per-process unless Redis is configured.
