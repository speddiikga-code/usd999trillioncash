# syntax=docker/dockerfile:1.7
# One image recipe, three runtime targets: api, worker, dashboard.
#   docker build -f infrastructure/docker/Dockerfile --target api -t roos-api .

FROM node:24-alpine AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# ── dependencies (cached on lockfile) ────────────────────────────────────────
FROM base AS deps
COPY package.json package-lock.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm ci --no-audit --no-fund

# ── dashboard production build ───────────────────────────────────────────────
FROM deps AS build
COPY tsconfig.base.json tsconfig.json ./
RUN npm run build -w @roos/dashboard

# ── runtime base: non-root, no dev tooling beyond tsx (TypeScript executed directly) ──
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps --chown=node:node /app /app
COPY --chown=node:node tsconfig.base.json tsconfig.json ./
RUN mkdir -p /app/data/projects && chown -R node:node /app/data
USER node

FROM runtime AS api
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:4000/api/health || exit 1
CMD ["node", "--import", "tsx", "apps/api/src/main.ts"]

FROM runtime AS worker
CMD ["node", "--import", "tsx", "apps/worker/src/main.ts"]

FROM base AS dashboard
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 3000
CMD ["npm", "run", "start", "-w", "@roos/dashboard"]
