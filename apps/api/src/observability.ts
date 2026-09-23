import { safeFetch } from '@roos/security';
import type { AppConfig, Logger } from '@roos/shared';

/** In-process request metrics exported in Prometheus text format at /api/metrics. */
export class Metrics {
  private requests = new Map<string, number>();
  private latency = new Map<string, { count: number; sum: number; buckets: number[] }>();
  private static BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
  readonly started = Date.now();

  observe(method: string, route: string, status: number, ms: number) {
    const key = `${method} ${route} ${status}`;
    this.requests.set(key, (this.requests.get(key) ?? 0) + 1);
    const lk = `${method} ${route}`;
    const h = this.latency.get(lk) ?? { count: 0, sum: 0, buckets: Metrics.BUCKETS.map(() => 0) };
    h.count++;
    h.sum += ms;
    Metrics.BUCKETS.forEach((b, i) => {
      if (ms <= b) h.buckets[i]!++;
    });
    this.latency.set(lk, h);
  }

  render(extra: Record<string, number> = {}): string {
    const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const lines = ['# HELP roos_http_requests_total HTTP requests', '# TYPE roos_http_requests_total counter'];
    for (const [k, v] of this.requests) {
      const [method, route, status] = k.split(' ');
      lines.push(`roos_http_requests_total{method="${method}",route="${esc(route!)}",status="${status}"} ${v}`);
    }
    lines.push('# HELP roos_http_request_duration_ms HTTP request latency', '# TYPE roos_http_request_duration_ms histogram');
    for (const [k, h] of this.latency) {
      const [method, route] = k.split(' ');
      const labels = `method="${method}",route="${esc(route!)}"`;
      Metrics.BUCKETS.forEach((b, i) => lines.push(`roos_http_request_duration_ms_bucket{${labels},le="${b}"} ${h.buckets[i]}`));
      lines.push(`roos_http_request_duration_ms_bucket{${labels},le="+Inf"} ${h.count}`, `roos_http_request_duration_ms_sum{${labels}} ${h.sum}`, `roos_http_request_duration_ms_count{${labels}} ${h.count}`);
    }
    lines.push('# TYPE roos_uptime_seconds gauge', `roos_uptime_seconds ${Math.round((Date.now() - this.started) / 1000)}`);
    for (const [k, v] of Object.entries(extra)) lines.push(`# TYPE ${k} gauge`, `${k} ${v}`);
    return lines.join('\n') + '\n';
  }
}

/** Error-tracking abstraction: logs always; optionally forwards to a webhook (Sentry-compatible relays, Slack, …). */
export class ErrorReporter {
  constructor(
    private cfg: AppConfig,
    private logger: Logger,
  ) {}

  capture(error: unknown, context: Record<string, unknown> = {}) {
    const e = error instanceof Error ? error : new Error(String(error));
    this.logger.error(e.message, { ...context, stack: e.stack?.split('\n').slice(0, 8).join('\n') });
    const url = this.cfg.observability.errorWebhookUrl;
    if (url) {
      void safeFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: e.message, name: e.name, stack: e.stack, context, env: this.cfg.env, at: new Date().toISOString() }),
        timeoutMs: 5000,
      }).catch(() => undefined);
    }
  }
}
