'use client';

import Link from 'next/link';
import { useApi } from '@/lib/hooks';
import { ago, pct, usd, num } from '@/lib/format';
import { useEvents, useSession } from '@/components/providers';
import { Empty, KindBadge, Loading, Panel, ScoreRangeCell, StatTile, StatusBadge, Pending } from '@/components/blocks';
import { LineChart } from '@/components/charts';

export default function CommandCenter() {
  const { session } = useSession();
  const { recent } = useEvents();
  const kpis = useApi<any>('/api/portfolio', { refreshOn: ['revenue.', 'experiment.', 'opportunity.', 'task.'] });
  const opps = useApi<any>('/api/opportunities?limit=8&sort=updated', { refreshOn: ['opportunity.'] });
  const agents = useApi<any>('/api/agents', { refreshOn: ['task.'] });
  const tasks = useApi<any[]>('/api/tasks?limit=12', { refreshOn: ['task.'] });
  const exps = useApi<any[]>('/api/experiments?status=running', { refreshOn: ['experiment.', 'tracking.'] });
  const approvals = useApi<any[]>('/api/approvals?status=pending', { refreshOn: ['approval.'] });
  const alerts = useApi<any[]>('/api/alerts', { refreshOn: ['alert'] });
  const health = useApi<any>('/api/system/status', { intervalMs: 15000 });
  const pipeline = useApi<any>('/api/pipeline', { refreshOn: ['lead.'] });
  const k = kpis.data;
  const demo = session?.org.isDemo;
  const revenueBasis = demo ? 'DEMO' : 'Verified';

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Command center</h1>
          <div className="page-sub">
            Live state of every opportunity, agent, experiment and dollar. Figures are {demo ? <strong>synthetic DEMO DATA</strong> : <>verified from payment-provider data only</>}; estimates are labelled wherever they appear.
          </div>
        </div>
        <div className="row">
          <Link className="btn" href="/onboarding">
            Getting started
          </Link>
          <Link className="btn primary" href="/opportunities">
            Discover opportunities
          </Link>
        </div>
      </div>

      {!k ? (
        <Loading />
      ) : (
        <div className={`tiles ${kpis.loading ? 'refetching' : ''}`}>
          <StatTile label={`${revenueBasis} MRR`} value={usd(k.mrr)} sub={`ARR ${usd(k.arr, { compact: true })}`} badge={demo ? <KindBadge kind="DEMO" /> : null} />
          <StatTile label="Customers" value={num(k.customers)} sub={`${num(k.users30d)} visitors (30d)`} />
          <StatTile label="Opportunities" value={num(k.totalOpportunities)} sub={`${k.validatedOpportunities} validated`} />
          <StatTile label="Active experiments" value={num(k.activeExperiments)} sub={k.experimentWinRate === null ? 'No decided experiments yet' : `Win rate ${pct(k.experimentWinRate, 0)} of ${k.experimentsDecided}`} />
          <StatTile label="Products launched" value={num(k.productsLaunched)} sub="preview + live" />
          <StatTile label="Pipeline (weighted)" value={usd(k.pipelineWeighted, { compact: true })} sub={`${usd(k.pipelineTotal, { compact: true })} unweighted · ${k.leads} leads`} />
          <StatTile label="Gross margin" value={pct(k.grossMargin, 0)} sub={`CAC ${usd(k.cac)} · LTV ${usd(k.ltv)}${k.ltvAssumedLifetime ? '*' : ''}`} />
          <StatTile label="Cash burn (30d)" value={usd(k.cashBurn30d)} sub="expenses − revenue" />
          <StatTile label="Portfolio value" value={usd(k.portfolioValue?.mid, { compact: true })} sub={`model estimate, range ${usd(k.portfolioValue?.low, { compact: true })}–${usd(k.portfolioValue?.high, { compact: true })}`} badge={<KindBadge kind="MODEL_ASSUMPTION" />} />
          <StatTile label="Automation rate" value={pct(k.automationRate, 0)} sub="tasks completed without approval (30d)" />
        </div>
      )}

      <div className="grid g3">
        <Panel title="Live opportunities" actions={<Link className="small" href="/opportunities">All →</Link>} flush>
          {!opps.data ? <Pending q={opps} /> : !opps.data.items.length ? <Empty>No opportunities yet — run <code>/research &quot;topic&quot;</code>.</Empty> : (
            opps.data.items.map((o: any) => (
              <div key={o.id} className="list-item">
                <div className="row between">
                  <Link href={`/opportunities/${o.id}`} className="ellipsis" style={{ maxWidth: '70%' }}>{o.title}</Link>
                  <StatusBadge status={o.status} />
                </div>
                <div className="row small muted">
                  <ScoreRangeCell o={o} /> · {o.evidenceCount} evidence · {ago(o.updatedAt)}
                </div>
              </div>
            ))
          )}
        </Panel>

        <Panel title="Active agents" actions={<Link className="small" href="/agents">Tasks →</Link>} flush>
          {!agents.data ? <Pending q={agents} /> : (
            <div className="table-wrap">
              <table className="t">
                <tbody>
                  {agents.data.agents.map((a: any) => (
                    <tr key={a.name}>
                      <td className="nowrap">{a.name}</td>
                      <td><StatusBadge status={a.enabled ? a.status : 'disabled'} /></td>
                      <td className="r small muted">{a.queued ? `${a.queued} queued` : ''}{a.running ? ` ${a.running} running` : ''}</td>
                      <td className="r small muted">{a.lastRunAt ? ago(a.lastRunAt) : 'never'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel title="Approval queue" actions={<Link className="small" href="/approvals">Review →</Link>} flush>
          {!approvals.data ? <Pending q={approvals} /> : !approvals.data.length ? <Empty>Nothing waiting for a human decision.</Empty> : (
            approvals.data.slice(0, 6).map((a: any) => (
              <div key={a.id} className="list-item">
                <Link href="/approvals">{a.title}</Link>
                <div className="row small muted">
                  <StatusBadge status={a.risk?.level} label={`${a.risk?.level} risk`} /> · {usd(a.expectedCostUsd)} · {a.reversibility.replace('_', ' ')} · {ago(a.createdAt)}
                </div>
              </div>
            ))
          )}
        </Panel>

        <Panel title="Active experiments" actions={<Link className="small" href="/experiments">All →</Link>} flush>
          {!exps.data ? <Pending q={exps} /> : !exps.data.length ? <Empty>No running experiments. Try <code>/experiment &lt;opportunity-id&gt;</code>.</Empty> : (
            exps.data.map((x: any) => {
              const s = x.decisionRationale?.stats;
              return (
                <div key={x.id} className="list-item">
                  <Link href={`/experiments/${x.id}`}>{x.name}</Link>
                  <div className="row small muted">
                    <StatusBadge status={x.decision ?? 'CONTINUE'} /> {s ? `${pct(s.rate)} of ${num(s.denominator)} · P(>target) ${pct(s.probAboveTarget, 0)}` : 'not evaluated yet'}
                  </div>
                </div>
              );
            })
          )}
        </Panel>

        <Panel title={`Revenue — ${revenueBasis.toLowerCase()} MRR`} actions={<Link className="small" href="/revenue">Details →</Link>}>
          {k && k.revenueSeries?.some((p: any) => p.mrr > 0) ? (
            <LineChart
              height={180}
              area
              series={[{ key: 'mrr', name: `${revenueBasis} MRR`, color: 'var(--series-1)', values: k.revenueSeries.map((p: any, i: number) => ({ x: i, y: p.mrr })) }]}
              xFormat={(i) => k.revenueSeries[i]?.month ?? ''}
              yFormat={(v) => usd(v, { compact: true })}
            />
          ) : (
            <Empty>{demo ? 'No demo revenue.' : 'No verified revenue yet. Connect Stripe (Settings → Secrets) — manual entries are shown separately as user input.'}</Empty>
          )}
        </Panel>

        <Panel title="Pipeline & customers" actions={<Link className="small" href="/leads">CRM →</Link>}>
          {!pipeline.data ? <Pending q={pipeline} /> : (
            <div className="stack small">
              {Object.entries(pipeline.data.byStage ?? {}).map(([stage, v]: [string, any]) => (
                <div key={stage} className="row between">
                  <StatusBadge status={stage} />
                  <span className="num">{v.count} leads · {usd(v.weighted, { compact: true })} weighted</span>
                </div>
              ))}
              {!Object.keys(pipeline.data.byStage ?? {}).length && <span className="muted">No leads yet.</span>}
              <div className="tiny muted">{pipeline.data.assumption}</div>
            </div>
          )}
        </Panel>

        <Panel title="System health" actions={health.data ? <StatusBadge status={health.data.status} /> : null}>
          {!health.data ? <Pending q={health} /> : (
            <div className="stack small">
              <div className="row between"><span>Database</span><span>{health.data.database.kind} · {health.data.database.latencyMs}ms</span></div>
              <div className="row between"><span>Workers alive</span><span>{health.data.workers.filter((w: any) => w.alive).length}</span></div>
              <div className="row between"><span>Queue</span><span>{health.data.queue?.queued} queued · {health.data.queue?.running} running · {health.data.queue?.waiting_approval} awaiting approval</span></div>
              <div className="row between"><span>Failed tasks (24h)</span><span>{health.data.queue?.failed_24h}</span></div>
              <div className="row between"><span>Sandbox</span><span>{health.data.sandbox.driver} · {health.data.sandbox.available ? 'available' : 'unavailable'}</span></div>
              <div className="row between"><span>AI providers</span><span>{Object.entries(health.data.integrations.ai).filter(([, v]) => v).map(([p]) => p).join(', ') || 'none (heuristic mode)'}</span></div>
              {health.data.warnings.map((w: string) => (
                <div key={w} className="banner" style={{ marginBottom: 0 }}>{w}</div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="Alerts" flush>
          {!alerts.data ? <Pending q={alerts} /> : !alerts.data.length ? <Empty>No open alerts.</Empty> : (
            alerts.data.slice(0, 6).map((a: any) => (
              <div key={a.id} className="list-item">
                <div className="row"><StatusBadge status={a.severity} /> <strong className="small">{a.title}</strong></div>
                <div className="small muted">{a.message.slice(0, 180)}</div>
              </div>
            ))
          )}
        </Panel>

        <Panel title="Live events" flush>
          {!recent.length ? <Empty>Waiting for events… (actions, agent tasks and tracking events stream here)</Empty> : (
            <div className="feed">
              {recent.slice(0, 12).map((e) => (
                <div key={e.id} className="feed-item">
                  <span className="feed-time">{new Date(e.createdAt).toLocaleTimeString()}</span>
                  <span className="mono small">{e.type}</span>
                  <span className="small muted ellipsis">{String(e.payload.title ?? e.payload.kind ?? e.payload.agent ?? e.payload.decision ?? e.payload.status ?? '')}</span>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>

      <Panel title="Recent agent tasks" className="mt2" flush>
        {!tasks.data ? <Pending q={tasks} /> : !tasks.data.length ? <Empty>No tasks yet.</Empty> : (
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Agent</th><th>Task</th><th>Status</th><th className="r">Attempts</th><th className="r">AI cost</th><th>When</th></tr></thead>
              <tbody>
                {tasks.data.map((t: any) => (
                  <tr key={t.id}>
                    <td>{t.agent}</td>
                    <td className="mono small"><Link href={`/agents?task=${t.id}`}>{t.kind}</Link></td>
                    <td><StatusBadge status={t.status} /></td>
                    <td className="r">{t.attempts}</td>
                    <td className="r">{usd(t.costUsd, { cents: true })}</td>
                    <td className="small muted">{ago(t.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
