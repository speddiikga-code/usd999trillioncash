/**
 * Vetted, generic runtime of every generated MVP (zero dependencies, Node ≥ 20).
 * Only lib/spec.js, the HTML pages, schema.sql, openapi.json and docs differ per product.
 * These strings are written verbatim — they contain no template substitutions.
 */

export const SERVER_JS = String.raw`import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SPEC } from './lib/spec.js';
import { createStore } from './lib/store.js';
import { validateEntity, validateEmail, cleanString } from './lib/validate.js';
import { track } from './lib/analytics.js';
import { createCheckout } from './lib/payments.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const MAX_BODY = 64 * 1024;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};
const CLIENT_EVENTS = ['page_view', 'cta_click', 'activation', 'demo_requested', 'checkout_started'];

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({}, SECURITY_HEADERS, headers || {}));
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        // Drain so the client receives a clean 413; hard-stop abusive streams.
        tooLarge = true;
        if (size > MAX_BODY * 16) req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) return reject(httpError(413, 'Payload too large'));
      if (!chunks.length) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return reject(httpError(400, 'Expected a JSON object'));
        resolve(parsed);
      } catch {
        reject(httpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** Variants/headlines for the landing page; ROOS_VARIANTS_JSON can override without regenerating. */
function landingConfig() {
  let cfg = { variants: SPEC.variants, headlines: SPEC.headlines };
  if (process.env.ROOS_VARIANTS_JSON) {
    try {
      const o = JSON.parse(process.env.ROOS_VARIANTS_JSON);
      if (Array.isArray(o.variants) && o.variants.length) cfg = { variants: o.variants.map(String).slice(0, 6), headlines: o.headlines || {} };
    } catch {
      /* ignore invalid override */
    }
  }
  // Safe to embed in a <script type="application/json"> block.
  return JSON.stringify(cfg).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

async function serveStatic(res, rel) {
  const target = path.normalize(path.join(PUBLIC, rel));
  if (!target.startsWith(PUBLIC + path.sep)) return sendJson(res, 404, { error: 'Not found' });
  try {
    let body = await readFile(target);
    if (rel === 'index.html') body = Buffer.from(body.toString('utf8').replace('__ROOS_CONFIG__', landingConfig()));
    send(res, 200, body, { 'content-type': TYPES[path.extname(target)] || 'application/octet-stream' });
  } catch {
    sendJson(res, 404, { error: 'Not found' });
  }
}

function context(req, body) {
  // Events are forwarded server-side, so pass the visitor's user agent along for bot filtering.
  const userAgent = cleanString(req.headers['user-agent'], 300);
  return {
    anonymousId: cleanString(body.anonymousId || req.headers['x-anonymous-id'], 128) || 'anonymous',
    variant: cleanString(body.variant, 32) || undefined,
    ref: cleanString(body.ref, 64) || undefined,
    path: cleanString(body.path, 300) || undefined,
    properties: userAgent ? { userAgent: userAgent } : undefined,
  };
}

async function handleApi(req, res, parts, store) {
  const resource = parts[0];
  const id = parts[1];
  if (resource === 'spec' && req.method === 'GET') {
    return sendJson(res, 200, { name: SPEC.name, tagline: SPEC.tagline, entities: SPEC.entities, pricingTiers: SPEC.pricingTiers });
  }
  if (resource === 'signup' && req.method === 'POST') {
    const body = await readBody(req);
    const email = validateEmail(body.email);
    if (!email) throw httpError(400, 'A valid email address is required');
    const ctx = context(req, body);
    const existing = store.list('signups').find((s) => s.email === email);
    if (!existing) store.insert('signups', { email: email, name: cleanString(body.name, 100), ref: ctx.ref, variant: ctx.variant, anonymousId: ctx.anonymousId });
    await track('signup', Object.assign({ email: email, name: cleanString(body.name, 100) || undefined }, ctx));
    return sendJson(res, 201, { ok: true, duplicate: !!existing });
  }
  if (resource === 'events' && req.method === 'POST') {
    const body = await readBody(req);
    if (!CLIENT_EVENTS.includes(body.event)) throw httpError(400, 'Unsupported event');
    await track(body.event, context(req, body));
    return sendJson(res, 202, { ok: true });
  }
  if (resource === 'checkout' && req.method === 'POST') {
    const body = await readBody(req);
    const tier = SPEC.pricingTiers.find((t) => t.name === body.tier) || SPEC.pricingTiers[0];
    await track('checkout_started', Object.assign({ valueUsd: tier ? tier.priceUsdMonthly : undefined }, context(req, body)));
    const result = createCheckout({ tier: tier ? tier.name : undefined });
    return sendJson(res, result.ok ? 200 : result.status, result.ok ? { url: result.url } : { error: result.error });
  }

  const entity = SPEC.entities.find((e) => e.plural === resource);
  if (!entity) throw httpError(404, 'Not found');
  if (!id && req.method === 'GET') return sendJson(res, 200, { items: store.list(entity.plural) });
  if (!id && req.method === 'POST') {
    const body = await readBody(req);
    const result = validateEntity(entity, body, false);
    if (result.errors.length) return sendJson(res, 400, { error: 'Validation failed', errors: result.errors });
    const item = store.insert(entity.plural, result.value);
    if (store.count(entity.plural) === 1) await track('activation', context(req, {}));
    return sendJson(res, 201, item);
  }
  if (id) {
    const item = store.get(entity.plural, id);
    if (!item) throw httpError(404, 'Not found');
    if (req.method === 'GET') return sendJson(res, 200, item);
    if (req.method === 'PUT') {
      const body = await readBody(req);
      const result = validateEntity(entity, body, true);
      if (result.errors.length) return sendJson(res, 400, { error: 'Validation failed', errors: result.errors });
      return sendJson(res, 200, store.update(entity.plural, id, result.value));
    }
    if (req.method === 'DELETE') {
      store.remove(entity.plural, id);
      res.writeHead(204, SECURITY_HEADERS);
      return res.end();
    }
  }
  throw httpError(405, 'Method not allowed');
}

export function createServer(opts) {
  const options = opts || {};
  const store = createStore(options.dataDir || process.env.DATA_DIR || path.join(ROOT, 'data'));
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);
      if (req.method === 'GET' && url.pathname === '/health') return sendJson(res, 200, { ok: true, name: SPEC.name });
      if (req.method === 'GET' && url.pathname === '/') return await serveStatic(res, 'index.html');
      if (req.method === 'GET' && url.pathname === '/app') return await serveStatic(res, 'app.html');
      if (req.method === 'GET' && parts[0] === 'static') return await serveStatic(res, parts.slice(1).map(decodeURIComponent).join('/'));
      if (parts[0] === 'api') return await handleApi(req, res, parts.slice(1), store);
      sendJson(res, 404, { error: 'Not found' });
    } catch (e) {
      const status = (e && e.status) || 500;
      if (status === 500) console.error(e);
      if (!res.headersSent) sendJson(res, status, { error: status === 500 ? 'Internal error' : e.message });
    }
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  createServer().listen(port, host, () => console.log(SPEC.name + ' listening on http://' + host + ':' + port));
}
`;

export const STORE_JS = String.raw`import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Minimal JSON-file store with atomic writes. Replace with PostgreSQL (see schema.sql) when scaling. */
export function createStore(dir) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'db.json');
  let data = {};
  if (existsSync(file)) {
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      data = {};
    }
  }
  const save = () => {
    const tmp = file + '.tmp';
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, file);
  };
  const col = (c) => (data[c] = data[c] || []);
  return {
    list: (c) => col(c).slice().reverse(),
    get: (c, id) => col(c).find((x) => x.id === id) || null,
    count: (c) => col(c).length,
    insert(c, value) {
      const now = new Date().toISOString();
      const item = Object.assign({}, value, { id: randomUUID(), createdAt: now, updatedAt: now });
      col(c).push(item);
      save();
      return item;
    },
    update(c, id, patch) {
      const item = col(c).find((x) => x.id === id);
      if (!item) return null;
      Object.assign(item, patch, { updatedAt: new Date().toISOString() });
      save();
      return item;
    },
    remove(c, id) {
      const before = col(c).length;
      data[c] = col(c).filter((x) => x.id !== id);
      save();
      return data[c].length < before;
    },
  };
}
`;

export const VALIDATE_JS = String.raw`const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}$/;

export function cleanString(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

export function validateEmail(v) {
  const s = cleanString(v, 254).toLowerCase();
  return EMAIL.test(s) ? s : null;
}

const LIMITS = { string: 200, text: 5000 };

function coerce(field, raw) {
  switch (field.type) {
    case 'string':
    case 'text': {
      if (typeof raw !== 'string') return { error: 'must be a string' };
      const s = raw.trim();
      if (s.length > LIMITS[field.type]) return { error: 'is too long (max ' + LIMITS[field.type] + ')' };
      return { value: s };
    }
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(raw);
      return Number.isFinite(n) ? { value: n } : { error: 'must be a number' };
    }
    case 'boolean':
      return typeof raw === 'boolean' ? { value: raw } : { error: 'must be true or false' };
    case 'date': {
      if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(raw) || Number.isNaN(Date.parse(raw))) return { error: 'must be a date (YYYY-MM-DD)' };
      return { value: raw.slice(0, 10) };
    }
    case 'email': {
      const e = validateEmail(raw);
      return e ? { value: e } : { error: 'must be a valid email' };
    }
    case 'url': {
      try {
        const u = new URL(String(raw));
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: 'must be an http(s) URL' };
        return { value: u.toString() };
      } catch {
        return { error: 'must be a valid URL' };
      }
    }
    default:
      return { error: 'has an unsupported type' };
  }
}

/** Validate a payload against an entity spec. Unknown fields are dropped. */
export function validateEntity(entity, body, partial) {
  const value = {};
  const errors = [];
  for (const field of entity.fields) {
    const raw = body[field.name];
    const missing = raw === undefined || raw === null || raw === '';
    if (missing) {
      if (field.required && !partial) errors.push({ field: field.name, message: 'is required' });
      continue;
    }
    const r = coerce(field, raw);
    if (r.error) errors.push({ field: field.name, message: r.error });
    else value[field.name] = r.value;
  }
  return { value, errors };
}
`;

export const ANALYTICS_JS = String.raw`/**
 * Forwards funnel events to the ROOS tracking API. Disabled unless ROOS_TRACK_URL and
 * ROOS_WRITE_KEY are set (e.g. in tests and in the network-isolated sandbox).
 */
export async function track(event, payload) {
  const url = process.env.ROOS_TRACK_URL;
  const key = process.env.ROOS_WRITE_KEY;
  if (!url || !key) return { forwarded: false };
  const body = Object.assign({}, payload, { event: event });
  if (process.env.ROOS_EXPERIMENT_ID) body.experimentId = process.env.ROOS_EXPERIMENT_ID;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-roos-write-key': key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });
    return { forwarded: res.ok };
  } catch {
    return { forwarded: false };
  }
}
`;

export const PAYMENTS_JS = String.raw`/**
 * Payments interface. Charging customers is a consequential action: a Stripe payment link is
 * created in ROOS only after a human approves it, and then configured here via PAYMENT_LINK_URL.
 */
export function createCheckout(input) {
  const link = process.env.PAYMENT_LINK_URL;
  if (!link) {
    return { ok: false, status: 501, error: 'Payments are not enabled yet. Join the early-access list and we will contact you before any charge.' };
  }
  if (!/^https:\/\/(buy\.stripe\.com|checkout\.stripe\.com)\//.test(link)) {
    return { ok: false, status: 500, error: 'Payment link is misconfigured' };
  }
  return { ok: true, url: link, tier: input && input.tier };
}
`;

export const LANDING_JS = String.raw`(function () {
  var cfgEl = document.getElementById('roos-config');
  var cfg = { variants: ['control'], headlines: {} };
  try { cfg = JSON.parse(cfgEl.textContent); } catch (e) { /* default config */ }
  function store(key, make) {
    try {
      var v = localStorage.getItem(key);
      if (!v) { v = make(); localStorage.setItem(key, v); }
      return v;
    } catch (e) { return make(); }
  }
  var anon = store('roos_anon', function () { return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Math.random()).slice(2); });
  var variant = store('roos_variant', function () { return cfg.variants[Math.floor(Math.random() * cfg.variants.length)]; });
  if (cfg.variants.indexOf(variant) < 0) variant = cfg.variants[0];
  var headline = cfg.headlines && cfg.headlines[variant];
  if (headline) document.getElementById('headline').textContent = headline;
  var ref = new URLSearchParams(location.search).get('ref') || '';
  function post(path, body) {
    return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-anonymous-id': anon }, body: JSON.stringify(body) });
  }
  post('/api/events', { event: 'page_view', anonymousId: anon, variant: variant, ref: ref, path: location.pathname });

  var form = document.getElementById('signup-form');
  var msg = document.getElementById('signup-message');
  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var data = new FormData(form);
    post('/api/signup', { email: data.get('email'), name: data.get('name'), anonymousId: anon, variant: variant, ref: ref })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
      .then(function (r) {
        msg.textContent = r.ok ? 'Thanks! You are on the early-access list.' : (r.body.error || 'Something went wrong.');
        if (r.ok) form.reset();
      })
      .catch(function () { msg.textContent = 'Network error — please try again.'; });
  });

  Array.prototype.forEach.call(document.querySelectorAll('[data-tier]'), function (btn) {
    btn.addEventListener('click', function () {
      var tier = btn.getAttribute('data-tier');
      post('/api/events', { event: 'cta_click', anonymousId: anon, variant: variant, ref: ref });
      post('/api/checkout', { tier: tier, anonymousId: anon, variant: variant })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (j.url) { location.href = j.url; return; }
          var note = document.getElementById('pricing-message');
          note.textContent = j.error || 'Checkout unavailable.';
        });
    });
  });
})();
`;

export const APP_JS = String.raw`(function () {
  var anon = (function () { try { return localStorage.getItem('roos_anon') || 'app-user'; } catch (e) { return 'app-user'; } })();
  var root = document.getElementById('app');
  var headers = { 'content-type': 'application/json', 'x-anonymous-id': anon };
  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function inputFor(field) {
    var types = { string: 'text', text: 'text', number: 'number', boolean: 'checkbox', date: 'date', email: 'email', url: 'url' };
    var input = field.type === 'text' ? el('textarea', { name: field.name, rows: '2' }) : el('input', { name: field.name, type: types[field.type] || 'text' });
    if (field.required) input.setAttribute('required', '');
    return input;
  }
  function renderEntity(entity, container) {
    container.textContent = '';
    container.appendChild(el('h2', {}, entity.name + 's'));
    var form = el('form', { class: 'entity-form' });
    entity.fields.forEach(function (f) {
      var label = el('label', {}, f.name + (f.required ? ' *' : ''));
      label.appendChild(inputFor(f));
      form.appendChild(label);
    });
    var err = el('p', { class: 'error' });
    form.appendChild(el('button', { type: 'submit' }, 'Add ' + entity.name.toLowerCase()));
    form.appendChild(err);
    var list = el('ul', { class: 'items' });
    container.appendChild(form);
    container.appendChild(list);
    function refresh() {
      fetch('/api/' + entity.plural, { headers: headers }).then(function (r) { return r.json(); }).then(function (j) {
        list.textContent = '';
        if (!j.items.length) list.appendChild(el('li', { class: 'empty' }, 'Nothing here yet — add your first ' + entity.name.toLowerCase() + '.'));
        j.items.forEach(function (item) {
          var li = el('li');
          var firstField = entity.fields[0].name;
          li.appendChild(el('strong', {}, String(item[firstField] === undefined ? '(untitled)' : item[firstField])));
          entity.fields.slice(1).forEach(function (f) {
            if (item[f.name] !== undefined) li.appendChild(el('span', { class: 'meta' }, f.name + ': ' + String(item[f.name])));
          });
          var del = el('button', { class: 'link' }, 'Delete');
          del.addEventListener('click', function () { fetch('/api/' + entity.plural + '/' + encodeURIComponent(item.id), { method: 'DELETE', headers: headers }).then(refresh); });
          li.appendChild(del);
          list.appendChild(li);
        });
      });
    }
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var body = {};
      entity.fields.forEach(function (f) {
        var input = form.elements[f.name];
        if (f.type === 'boolean') body[f.name] = input.checked;
        else if (input.value !== '') body[f.name] = f.type === 'number' ? Number(input.value) : input.value;
      });
      fetch('/api/' + entity.plural, { method: 'POST', headers: headers, body: JSON.stringify(body) })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
        .then(function (r) {
          err.textContent = r.ok ? '' : (r.body.errors || []).map(function (e) { return e.field + ' ' + e.message; }).join('; ') || r.body.error;
          if (r.ok) { form.reset(); refresh(); }
        });
    });
    refresh();
  }
  fetch('/api/spec').then(function (r) { return r.json(); }).then(function (spec) {
    document.title = spec.name;
    var nav = el('nav', { class: 'tabs' });
    var panel = el('section', { class: 'panel' });
    spec.entities.forEach(function (entity, i) {
      var b = el('button', { type: 'button' }, entity.name + 's');
      b.addEventListener('click', function () { renderEntity(entity, panel); });
      nav.appendChild(b);
      if (i === 0) renderEntity(entity, panel);
    });
    root.appendChild(nav);
    root.appendChild(panel);
  });
})();
`;

export const STYLES_CSS = String.raw`:root { --bg: #0b1020; --panel: #121a33; --text: #e7ecff; --muted: #9aa6cc; --accent: #6ea8fe; --ok: #3ecf8e; --err: #ff6b6b; }
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
main { max-width: 960px; margin: 0 auto; padding: 32px 20px 64px; }
header.hero { padding: 48px 0 24px; }
.badge { display: inline-block; font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: var(--accent); border: 1px solid var(--accent); border-radius: 999px; padding: 2px 10px; }
h1 { font-size: clamp(28px, 5vw, 44px); line-height: 1.15; margin: 16px 0 12px; }
p.lead { color: var(--muted); font-size: 18px; max-width: 640px; }
form.signup { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 20px; }
input, textarea { background: var(--panel); color: var(--text); border: 1px solid #2a3560; border-radius: 8px; padding: 10px 12px; font: inherit; }
button { background: var(--accent); color: #081028; border: 0; border-radius: 8px; padding: 10px 16px; font-weight: 600; cursor: pointer; }
button.link { background: none; color: var(--muted); padding: 0 6px; font-weight: 400; }
section { margin-top: 40px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; }
.card { background: var(--panel); border: 1px solid #1f2a50; border-radius: 12px; padding: 18px; }
.price { font-size: 28px; font-weight: 700; }
.muted, .meta { color: var(--muted); font-size: 14px; }
.meta { margin-left: 10px; }
.error { color: var(--err); }
#signup-message { color: var(--ok); }
.tabs { display: flex; gap: 8px; margin-bottom: 16px; }
.items { list-style: none; padding: 0; }
.items li { background: var(--panel); border-radius: 8px; padding: 10px 12px; margin: 6px 0; }
.entity-form { display: grid; gap: 10px; max-width: 520px; }
.entity-form label { display: grid; gap: 4px; font-size: 14px; color: var(--muted); }
footer { margin-top: 56px; color: var(--muted); font-size: 13px; }
`;
