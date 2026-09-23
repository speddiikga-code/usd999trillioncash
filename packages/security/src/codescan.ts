/**
 * Static security scan for generated source code before it is executed in the sandbox or deployed.
 * This complements (never replaces) runtime isolation: container limits, no network, read-only FS.
 */
export interface ScanFinding {
  file: string;
  line: number;
  rule: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
}

export interface ScanResult {
  passed: boolean;
  findings: ScanFinding[];
  dependencyViolations: string[];
  outboundHosts: string[];
}

interface Rule {
  id: string;
  re: RegExp;
  severity: ScanFinding['severity'];
  message: string;
  files?: RegExp;
}

const RULES: Rule[] = [
  { id: 'no-child-process', re: /\bchild_process\b|\bspawn\s*\(|\bexecSync\s*\(|\bexecFile\s*\(/, severity: 'error', message: 'Spawning processes is not allowed in generated apps' },
  { id: 'no-eval', re: /\beval\s*\(|\bnew\s+Function\s*\(/, severity: 'error', message: 'Dynamic code evaluation is not allowed' },
  { id: 'no-vm', re: /require\(['"](node:)?vm['"]\)|from\s+['"](node:)?vm['"]/, severity: 'error', message: 'node:vm is not allowed' },
  { id: 'no-raw-sockets', re: /require\(['"](node:)?(net|dgram|tls)['"]\)|from\s+['"](node:)?(net|dgram|tls)['"]/, severity: 'error', message: 'Raw sockets are not allowed; use the http server only' },
  { id: 'no-process-binding', re: /process\.(binding|dlopen)\b/, severity: 'error', message: 'Native bindings are not allowed' },
  { id: 'no-env-dump', re: /JSON\.stringify\(\s*process\.env\s*\)|console\.log\(\s*process\.env\s*\)/, severity: 'error', message: 'Dumping the environment leaks secrets' },
  { id: 'no-innerhtml', re: /\.innerHTML\s*=(?!\s*['"`]\s*['"`])/, severity: 'warning', message: 'innerHTML assignment — ensure content is escaped', files: /\.(js|html)$/ },
  { id: 'no-document-write', re: /document\.write\s*\(/, severity: 'warning', message: 'document.write is unsafe', files: /\.(js|html)$/ },
  { id: 'no-fs-root', re: /['"]\/(etc|proc|sys|root|var\/run)\//, severity: 'error', message: 'Access to system paths is not allowed' },
  { id: 'no-hardcoded-secret', re: /(sk-[A-Za-z0-9]{20,}|sk_live_[A-Za-z0-9]{10,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|-----BEGIN (RSA |EC )?PRIVATE KEY-----)/, severity: 'error', message: 'Hard-coded secret detected' },
  { id: 'no-sql-concat', re: /(query|exec)\s*\(\s*[`'"][^`'"]*\b(SELECT|INSERT|UPDATE|DELETE)\b[^`'"]*[`'"]\s*\+/i, severity: 'warning', message: 'Possible SQL built by string concatenation' },
];

const URL_RE = /https?:\/\/([a-z0-9.-]+\.[a-z]{2,})(?::\d+)?/gi;

export interface ScanOptions {
  dependencyAllowlist?: string[];
  hostAllowlist?: string[];
}

export function scanSources(files: { path: string; content: string }[], opts: ScanOptions = {}): ScanResult {
  const findings: ScanFinding[] = [];
  const hosts = new Set<string>();
  const dependencyViolations: string[] = [];

  for (const f of files) {
    if (/\.(png|jpg|ico|woff2?)$/i.test(f.path)) continue;
    const lines = f.content.split('\n');
    lines.forEach((line, i) => {
      for (const r of RULES) {
        if (r.files && !r.files.test(f.path)) continue;
        if (/\.md$/i.test(f.path) && r.id !== 'no-hardcoded-secret') continue;
        if (r.re.test(line)) findings.push({ file: f.path, line: i + 1, rule: r.id, severity: r.severity, message: r.message });
      }
      for (const m of line.matchAll(URL_RE)) hosts.add(m[1]!.toLowerCase());
    });

    if (/(^|\/)package\.json$/.test(f.path)) {
      try {
        const pkg = JSON.parse(f.content) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string> };
        const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
        for (const name of Object.keys(deps)) {
          if (!(opts.dependencyAllowlist ?? []).includes(name)) dependencyViolations.push(name);
        }
        for (const [name, script] of Object.entries(pkg.scripts ?? {})) {
          if (/^(pre|post)?install$/.test(name) || /curl|wget|\bsh\b|bash|powershell/.test(script)) {
            findings.push({ file: f.path, line: 1, rule: 'no-install-scripts', severity: 'error', message: `Script "${name}" is not allowed: ${script}` });
          }
        }
      } catch {
        findings.push({ file: f.path, line: 1, rule: 'invalid-package-json', severity: 'error', message: 'package.json is not valid JSON' });
      }
    }
  }

  const outboundHosts = [...hosts].sort();
  if (opts.hostAllowlist) {
    for (const h of outboundHosts) {
      if (!opts.hostAllowlist.some((a) => h === a || h.endsWith('.' + a))) {
        findings.push({ file: '*', line: 0, rule: 'outbound-host', severity: 'warning', message: `References non-allow-listed host ${h}` });
      }
    }
  }

  const passed = !findings.some((f) => f.severity === 'error') && dependencyViolations.length === 0;
  return { passed, findings, dependencyViolations, outboundHosts };
}
