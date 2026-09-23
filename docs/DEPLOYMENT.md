# Deployment

## Single host with Docker Compose (reference)

[`infrastructure/deployment/docker-compose.prod.yml`](../infrastructure/deployment/docker-compose.prod.yml)
runs PostgreSQL, Redis, the API, the worker, the dashboard, and Caddy for automatic HTTPS.

```bash
cp .env.example .env.production
# Edit .env.production, at minimum:
#   NODE_ENV=production
#   APP_SECRET=$(openssl rand -base64 48)
#   ENCRYPTION_KEY=$(openssl rand -base64 32)
#   API_PUBLIC_URL=https://roos.example.com   APP_URL=https://roos.example.com
#   HTTP_USER_AGENT="ROOS/0.1 (+contact: ops@example.com)"
#   SANDBOX_DRIVER=disabled   (or docker — see "Code sandbox" below)
export POSTGRES_PASSWORD=$(openssl rand -hex 24) REDIS_PASSWORD=$(openssl rand -hex 24) ROOS_DOMAIN=roos.example.com
docker compose -f infrastructure/deployment/docker-compose.prod.yml --env-file .env.production up -d --build

# First administrator (registration is closed in production):
docker compose -f infrastructure/deployment/docker-compose.prod.yml exec api \
  node --import tsx packages/core/src/cli.ts bootstrap-admin you@example.com 'a long passphrase' "Your Name"
```

Migrations run automatically on start, under an advisory lock.

### Checklist

- [ ] `APP_SECRET` and `ENCRYPTION_KEY` are generated, stored in a secret manager and backed up.
      Losing `ENCRYPTION_KEY` makes stored provider keys unreadable.
- [ ] DNS for `ROOS_DOMAIN` points at the host, and ports 80/443 are open (Caddy issues the
      certificates).
- [ ] `TRUST_PROXY=true` and `COOKIE_SECURE=true` (set by the compose file).
- [ ] PostgreSQL backups: nightly `pg_dump` or volume snapshots, with a tested restore.
- [ ] `METRICS_TOKEN` is set and Prometheus scrapes `https://…/api/metrics`. `ERROR_WEBHOOK_URL`
      is set.
- [ ] Stripe webhook points to `https://…/api/webhooks/stripe/<workspace-slug>` with a restricted
      read-only key.
- [ ] Email: `EMAIL_DRIVER=resend` only after the sending domain is verified (SPF/DKIM/DMARC) and
      `COMPANY_POSTAL_ADDRESS` is set.
- [ ] `SEED_DEMO=false` if you don't want the demo workspace. `DEMO_GUEST_LOGIN` is off by
      default in production.
- [ ] `npm run audit:deps` is clean, and images are rebuilt regularly for base-image patches.

## Scaling

- **API**: stateless. Run several replicas behind the proxy; Redis gives shared rate limits.
- **Workers**: scale horizontally. Tasks are claimed with `FOR UPDATE SKIP LOCKED`, and the
  scheduler's periodic jobs use deterministic ids, so duplicate schedulers are harmless.
  - `WORKER_ROLES` specialises workers, e.g. a pool for `ResearchAgent,MarketAgent` and one for
    `CodeAgent`.
- **Database**: all state lives in PostgreSQL. Use a managed Postgres with PITR for serious use.

## Code sandbox

Generated MVPs are executed only inside the sandbox:

| Driver | Isolation | Production |
|---|---|---|
| `docker` | `--network none`, read-only root, tmpfs, all capabilities dropped, `no-new-privileges`, memory/CPU/PID limits, non-root user | ✅ Recommended. The worker needs the Docker CLI and a daemon. The reference worker image has neither: add `docker-cli` to the `worker` target and point `DOCKER_HOST` at a sandbox daemon. |
| `process` | Node permission model (filesystem only; **no network isolation**) | ❌ Refused at startup |
| `disabled` | No execution. Code is generated and scanned but not tested or previewed. | ✅ Safe default in the compose files |

Giving the worker the host's Docker socket is **root-equivalent**. Prefer one of these:

- a separate, dedicated sandbox host (e.g. `DOCKER_HOST=ssh://sandbox@…`)
- rootless Docker
- a VM-isolated runtime (gVisor / Kata / Firecracker)

## Deploying generated MVPs publicly

Production deploys of generated products are **approval-gated** and ROOS does not push to any
host by itself. After approval, the project page shows the instructions. The generated app is a
zero-dependency Node service: `node server.js`, `PORT`, and `DATA_DIR` for its JSON store. To
connect it to ROOS tracking, set:

```bash
ROOS_TRACK_URL=https://roos.example.com/api/track
ROOS_WRITE_KEY=pk_…            # from the product page
ROOS_EXPERIMENT_ID=exp_…        # optional
PAYMENT_LINK_URL=https://buy.stripe.com/…   # optional
```

Its JSON-file store suits validation traffic. Before real customers depend on it, move it to a
database using the `schema.sql` it ships with.
