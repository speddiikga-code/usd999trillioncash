import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const API = process.env.ROOS_API_INTERNAL_URL || `http://127.0.0.1:${process.env.API_PORT || 4000}`;
const isDev = process.env.NODE_ENV !== 'production';

/**
 * The dashboard is a pure client of the ROOS API. `/api/*` is proxied to the API so the browser
 * talks to a single origin: session cookies stay first-party (SameSite=Lax, HttpOnly) and no CORS
 * is needed. Security headers are applied to every page.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  `connect-src 'self'${isDev ? ' ws: wss:' : ''}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  poweredByHeader: false,
  compress: false, // never buffer the SSE event stream
  agentRules: false, // don't let `next dev` write AGENTS.md / CLAUDE.md into the repo
  turbopack: { root: path.join(here, '../..') },
  outputFileTracingRoot: path.join(here, '../..'),
  output: process.env.NEXT_OUTPUT === 'standalone' ? 'standalone' : undefined,
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API}/api/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default config;
