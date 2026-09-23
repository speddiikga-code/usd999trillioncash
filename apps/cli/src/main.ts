import { loadEnvFile } from '@roos/shared';

/**
 * ROOS command-center CLI — talks to the API over HTTP with an API key.
 *
 *   ROOS_API_KEY=roos_… npm run roos -- /research "find underserved B2B AI opportunities"
 *   npm run roos -- /analyze opp_01…
 *   npm run roos -- /status
 *   npm run roos -- watch <workflowId>        (poll a workflow until it finishes)
 *   npm run roos -- approvals                 (list pending approvals)
 *   npm run roos -- approve <approvalId> [note] / reject <approvalId> [note]
 *
 * Environment: ROOS_API_URL (default http://127.0.0.1:4000), ROOS_API_KEY (create one in
 * Settings → API keys, or with `npm run bootstrap:admin`), ROOS_ORG_ID (optional).
 */
loadEnvFile();
const base = (process.env.ROOS_API_URL ?? `http://127.0.0.1:${process.env.API_PORT ?? 4000}`).replace(/\/$/, '');
const key = process.env.ROOS_API_KEY;
const args = process.argv.slice(2);

const c = { dim: (s: string) => `\x1b[2m${s}\x1b[0m`, bold: (s: string) => `\x1b[1m${s}\x1b[0m`, green: (s: string) => `\x1b[32m${s}\x1b[0m`, red: (s: string) => `\x1b[31m${s}\x1b[0m`, yellow: (s: string) => `\x1b[33m${s}\x1b[0m` };

async function call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  if (!key) {
    console.error(c.red('ROOS_API_KEY is not set. Create an API key in the dashboard (Settings → API keys) or run `npm run bootstrap:admin`.'));
    process.exit(2);
  }
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...(process.env.ROOS_ORG_ID ? { 'x-org-id': process.env.ROOS_ORG_ID } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch((e: Error) => {
    console.error(c.red(`Cannot reach the API at ${base}: ${e.message}. Is \`npm run dev\` running?`));
    process.exit(2);
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    console.error(c.red(`${res.status} ${data.error?.code ?? ''}: ${data.error?.message ?? text}`));
    if (data.error?.details) console.error(c.dim(JSON.stringify(data.error.details, null, 2)));
    process.exit(1);
  }
  return data as T;
}

const statusColor = (s: string) => (s === 'succeeded' ? c.green(s) : ['failed', 'timed_out', 'cancelled'].includes(s) ? c.red(s) : c.yellow(s));

async function watch(workflowId: string) {
  const seen = new Map<string, string>();
  for (;;) {
    const wf = await call<{ done: boolean; tasks: { id: string; agent: string; kind: string; status: string; error?: string; output?: Record<string, unknown> }[] }>('GET', `/api/workflows/${workflowId}`);
    for (const t of wf.tasks) {
      if (seen.get(t.id) !== t.status) {
        seen.set(t.id, t.status);
        console.log(`${c.dim(new Date().toISOString().slice(11, 19))} ${t.agent.padEnd(15)} ${t.kind.padEnd(32)} ${statusColor(t.status)}${t.error ? c.red(`  ${t.error.slice(0, 160)}`) : ''}`);
        if (t.status === 'waiting_approval') console.log(c.yellow('   ↳ waiting for human approval — run `npm run roos -- approvals`'));
      }
    }
    if (wf.done || wf.tasks.every((t) => ['succeeded', 'failed', 'cancelled', 'timed_out', 'waiting_approval'].includes(t.status))) {
      const last = wf.tasks.filter((t) => t.status === 'succeeded').at(-1);
      if (last?.output) console.log(c.dim(JSON.stringify(last.output, null, 2).slice(0, 3000)));
      return;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

async function main() {
  const [first, ...rest] = args;
  if (!first || first === 'help' || first === '--help') {
    const r = await call<{ message: string }>('POST', '/api/commands', { command: '/help' });
    console.log(r.message);
    console.log(c.dim('\nAlso: watch <workflowId> · approvals · approve <id> [note] · reject <id> [note] · opportunities'));
    return;
  }
  if (first.startsWith('/')) {
    const command = [first, ...rest.map((a) => (/\s/.test(a) ? `"${a}"` : a))].join(' ');
    const r = await call<{ message: string; workflowId?: string; tasks?: unknown[] }>('POST', '/api/commands', { command });
    console.log(r.message);
    if (r.workflowId) {
      console.log(c.dim(`workflow ${r.workflowId}`));
      await watch(r.workflowId);
    }
    return;
  }
  switch (first) {
    case 'watch':
      return watch(rest[0]!);
    case 'opportunities': {
      const r = await call<{ items: { id: string; title: string; score: number | null; status: string; scoreBreakdown?: { low: number; high: number } }[] }>('GET', '/api/opportunities?limit=20');
      for (const o of r.items) console.log(`${o.id}  ${String(o.score?.toFixed(2) ?? '—').padStart(5)} ${c.dim(o.scoreBreakdown ? `[${o.scoreBreakdown.low.toFixed(2)}–${o.scoreBreakdown.high.toFixed(2)}]` : '')}  ${o.status.padEnd(13)} ${o.title}`);
      return;
    }
    case 'approvals': {
      const r = await call<{ id: string; title: string; actionType: string; expectedCostUsd: number; risk: { level: string }; reversibility: string; what: string; why: string }[]>('GET', '/api/approvals?status=pending');
      if (!r.length) console.log('No pending approvals.');
      for (const a of r) {
        console.log(`${c.bold(a.id)} ${a.title}`);
        console.log(`  action ${a.actionType} · cost $${a.expectedCostUsd} · risk ${a.risk.level} · ${a.reversibility}`);
        console.log(c.dim(`  WHAT: ${a.what}\n  WHY:  ${a.why}`));
      }
      return;
    }
    case 'approve':
    case 'reject': {
      const r = await call<{ status: string }>('POST', `/api/approvals/${rest[0]}/${first}`, { note: rest.slice(1).join(' ') || undefined });
      console.log(`${rest[0]} → ${statusColor(r.status)}`);
      return;
    }
    default:
      console.error(`Unknown command "${first}". Try: npm run roos -- help`);
      process.exitCode = 1;
  }
}

await main();
