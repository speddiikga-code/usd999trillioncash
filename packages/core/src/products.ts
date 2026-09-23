import path from 'node:path';
import type { Db } from '@roos/database';
import { json } from '@roos/database';
import { buildSpec, generateProject, GENERATOR_VERSION, LocalDeployer, pickSandbox, writeProject, type MvpSpec, type SandboxResult } from '@roos/factory';
import { scanSources, type ScanResult } from '@roos/security';
import { camelize, ConflictError, errorMessage, newId, NotFoundError, randomToken, slugify, type AppConfig, type BusinessHypothesis, type Logger } from '@roos/shared';
import type { Actor, AuditService } from './audit';
import type { EventBus } from './events';
import type { OpportunityService } from './opportunities';
import { markStep } from './orgs';
import type { PolicyEngine } from './policy';

export interface BuildResult {
  projectId: string;
  productId: string;
  path: string;
  files: number;
  scan: ScanResult;
  tests: SandboxResult | { status: 'skipped'; reason: string };
  status: 'generated' | 'scan_failed' | 'tests_passed' | 'tests_failed';
}

/**
 * Products, generated projects (MVP factory) and deployments.
 * Build pipeline: spec → generate → write → static security scan → sandboxed tests → record.
 */
export class ProductService {
  readonly deployer: LocalDeployer;

  constructor(
    private db: Db,
    private cfg: AppConfig,
    private logger: Logger,
    private audit: AuditService,
    private events: EventBus,
    private policy: PolicyEngine,
    private opportunities: OpportunityService,
  ) {
    this.deployer = new LocalDeployer({ portStart: cfg.sandbox.deployPortStart, portEnd: cfg.sandbox.deployPortEnd, image: cfg.sandbox.image });
  }

  async createProduct(orgId: string, input: { name: string; opportunityId?: string | null; projectId?: string | null; description?: string; pricing?: unknown; businessModel?: string; status?: string }) {
    const id = newId('product');
    const row = await this.db.one(
      `INSERT INTO products (id, org_id, opportunity_id, project_id, name, description, status, pricing, business_model, write_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [id, orgId, input.opportunityId ?? null, input.projectId ?? null, input.name, input.description ?? '', input.status ?? 'draft', json(input.pricing ?? {}), input.businessModel ?? null, `pk_${randomToken(18)}`],
    );
    return camelize<Record<string, any>>(row!);
  }

  async getProduct(orgId: string, id: string) {
    const row = await this.db.one('SELECT * FROM products WHERE id = $1 AND org_id = $2', [id, orgId]);
    if (!row) throw new NotFoundError('Product', id);
    return camelize<Record<string, any>>(row);
  }

  async listProducts(orgId: string) {
    return (
      await this.db.many(
        `SELECT p.*, (SELECT COUNT(DISTINCT anonymous_id) FROM tracking_events t WHERE t.product_id = p.id AND t.occurred_at > now() - interval '30 days' AND NOT t.is_bot)::int AS visitors_30d
         FROM products p WHERE p.org_id = $1 ORDER BY p.created_at DESC`,
        [orgId],
      )
    ).map((r) => camelize(r));
  }

  async productForOpportunity(orgId: string, opportunityId: string) {
    const row = await this.db.one('SELECT * FROM products WHERE org_id = $1 AND opportunity_id = $2 ORDER BY created_at DESC LIMIT 1', [orgId, opportunityId]);
    return row ? camelize<Record<string, any>>(row) : null;
  }

  projectDir(orgId: string, projectId: string) {
    return path.join(this.cfg.sandbox.projectsDir, orgId, projectId);
  }

  async build(orgId: string, opportunityId: string, hypothesis: BusinessHypothesis, actor: Actor, opts: { variants?: string[]; headlines?: Record<string, string> } = {}): Promise<BuildResult> {
    const opp = await this.opportunities.get(orgId, opportunityId);
    const spec: MvpSpec = buildSpec(opp, hypothesis, opts);
    const projectId = newId('project');
    const dir = this.projectDir(orgId, projectId);
    const files = generateProject(spec);
    const manifest = writeProject(dir, files, { clean: true });
    const scan = scanSources(files, { dependencyAllowlist: [] });

    let tests: BuildResult['tests'] = { status: 'skipped', reason: 'Static scan failed — code was not executed.' };
    if (scan.passed) {
      const execPolicy = await this.policy.evaluate(orgId, 'code.execute_sandbox');
      const sandbox = execPolicy.decision === 'allow' ? await pickSandbox(this.cfg.sandbox.driver, this.cfg.sandbox.image) : null;
      if (execPolicy.decision !== 'allow') tests = { status: 'skipped', reason: `Sandbox execution not allowed by policy (${execPolicy.mode}).` };
      else if (!sandbox) tests = { status: 'skipped', reason: `Sandbox driver "${this.cfg.sandbox.driver}" is unavailable (is Docker running?). Set SANDBOX_DRIVER=process for local development.` };
      else tests = await sandbox.runTests(dir, { timeoutMs: this.cfg.sandbox.timeoutMs, memoryMb: this.cfg.sandbox.memoryMb, cpus: this.cfg.sandbox.cpus, network: 'none' });
    }
    const status: BuildResult['status'] = !scan.passed ? 'scan_failed' : tests.status === 'passed' ? 'tests_passed' : tests.status === 'skipped' ? 'generated' : 'tests_failed';

    return this.db.tx(async () => {
      await this.db.query(
        `INSERT INTO projects (id, org_id, opportunity_id, hypothesis_id, name, slug, spec, path, manifest, status, scan_result, test_result, generator_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [projectId, orgId, opportunityId, hypothesis.id, spec.name, spec.slug || slugify(spec.name), json(spec), dir, json(manifest), status, json(scan), json(tests), GENERATOR_VERSION],
      );
      if ('driver' in tests) {
        await this.db.query(`INSERT INTO sandbox_runs (id, org_id, project_id, driver, command, status, exit_code, stdout, stderr, duration_ms, limits) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [
          newId('sandboxRun'),
          orgId,
          projectId,
          tests.driver,
          tests.command.slice(0, 2000),
          tests.status,
          tests.exitCode,
          tests.stdout,
          tests.stderr,
          tests.durationMs,
          json({ ...tests.limits, isolation: tests.isolation }),
        ]);
      }
      let product = await this.productForOpportunity(orgId, opportunityId);
      if (product) {
        await this.db.query('UPDATE products SET project_id = $3, name = $4, pricing = $5, business_model = $6, updated_at = now() WHERE id = $1 AND org_id = $2', [product.id, orgId, projectId, spec.name, json(hypothesis.pricing), hypothesis.model]);
      } else {
        product = await this.createProduct(orgId, { name: spec.name, opportunityId, projectId, description: spec.valueProposition, pricing: hypothesis.pricing, businessModel: hypothesis.model });
      }
      await this.opportunities.update(orgId, opportunityId, { status: status === 'tests_passed' || status === 'generated' ? 'built' : 'building', selectedHypothesisId: hypothesis.id }, actor);
      await this.audit.record({ orgId, actor, action: 'project.generate', targetType: 'project', targetId: projectId, outcome: status === 'scan_failed' || status === 'tests_failed' ? 'failed' : 'success', details: { files: files.length, scanPassed: scan.passed, tests: tests.status } });
      await this.events.publish(orgId, 'project.generated', { entityType: 'project', entityId: projectId, payload: { status, opportunityId, productId: product.id } });
      await markStep(this.db, orgId, 'generate_mvp');
      return { projectId, productId: product.id as string, path: dir, files: files.length, scan, tests, status };
    });
  }

  async getProject(orgId: string, id: string) {
    const row = await this.db.one('SELECT * FROM projects WHERE id = $1 AND org_id = $2', [id, orgId]);
    if (!row) throw new NotFoundError('Project', id);
    return camelize<Record<string, any>>(row);
  }

  async listProjects(orgId: string) {
    return (await this.db.many('SELECT id, opportunity_id, hypothesis_id, name, status, path, generator_version, created_at, scan_result, test_result FROM projects WHERE org_id = $1 ORDER BY created_at DESC LIMIT 100', [orgId])).map((r) => camelize(r));
  }

  /** Local preview deployment (localhost). Allowed autonomously by default (deploy.local). */
  async deployLocal(orgId: string, projectId: string, actor: Actor, opts: { experimentId?: string } = {}) {
    const decision = await this.policy.evaluate(orgId, 'deploy.local');
    if (decision.decision !== 'allow') throw new ConflictError(`Local deployment blocked by policy: ${decision.reason}`);
    if (this.cfg.sandbox.driver === 'disabled') throw new ConflictError('Code execution is disabled (SANDBOX_DRIVER=disabled): generated projects are not run. Enable the docker sandbox to preview.');
    const project = await this.getProject(orgId, projectId);
    if (project.status === 'scan_failed' || project.status === 'tests_failed') throw new ConflictError(`Project status is ${project.status}; fix and rebuild before deploying.`);
    const product = await this.db.one<Record<string, any>>('SELECT * FROM products WHERE org_id = $1 AND project_id = $2', [orgId, projectId]);
    const depId = newId('deployment');
    await this.db.query(`INSERT INTO deployments (id, org_id, project_id, product_id, environment, driver, status) VALUES ($1,$2,$3,$4,'local',$5,'starting')`, [
      depId,
      orgId,
      projectId,
      product?.id ?? null,
      this.cfg.sandbox.driver === 'docker' ? 'docker' : 'process',
    ]);
    try {
      const env: Record<string, string> = { ROOS_TRACK_URL: `${this.cfg.api.publicUrl}/api/track` };
      if (product?.write_key) env.ROOS_WRITE_KEY = product.write_key;
      if (opts.experimentId) env.ROOS_EXPERIMENT_ID = opts.experimentId;
      const exp = opts.experimentId
        ? await this.db.one<{ variants: string[]; variant_copy: Record<string, string> }>('SELECT variants, variant_copy FROM experiments WHERE id = $1 AND org_id = $2', [opts.experimentId, orgId])
        : null;
      if (exp && exp.variants.length > 1) {
        const spec = project.spec as MvpSpec;
        // Variants without copy fall back to the control headline (an A/A comparison).
        env.ROOS_VARIANTS_JSON = JSON.stringify({ variants: exp.variants, headlines: Object.fromEntries(exp.variants.map((v) => [v, exp.variant_copy?.[v] ?? spec.tagline])) });
      }
      const dep = await this.deployer.start(depId, project.path, path.join(project.path, '..', `${projectId}-data`), env, this.cfg.sandbox.driver === 'docker' ? 'docker' : 'process');
      await this.db.query(`UPDATE deployments SET status = 'running', url = $3, port = $4, pid = $5, container_id = $6, started_at = now(), updated_at = now() WHERE id = $1 AND org_id = $2`, [depId, orgId, dep.url, dep.port, dep.pid ?? null, dep.containerId ?? null]);
      if (product) await this.db.query(`UPDATE products SET status = CASE WHEN status = 'draft' THEN 'preview' ELSE status END, url = $3, updated_at = now() WHERE id = $1 AND org_id = $2`, [product.id, orgId, dep.url]);
      await this.db.query(`UPDATE projects SET status = 'deployed', updated_at = now() WHERE id = $1 AND org_id = $2 AND status IN ('tests_passed','generated')`, [projectId, orgId]);
      if (project.opportunityId) await this.opportunities.update(orgId, project.opportunityId as string, { status: 'launched' }, actor);
      await this.audit.record({ orgId, actor, action: 'deploy.local', targetType: 'deployment', targetId: depId, details: { url: dep.url, driver: dep.driver } });
      await this.events.publish(orgId, 'deployment.updated', { entityType: 'deployment', entityId: depId, payload: { status: 'running', url: dep.url } });
      return { deploymentId: depId, url: dep.url, driver: dep.driver };
    } catch (e) {
      await this.db.query(`UPDATE deployments SET status = 'failed', error = $3, updated_at = now() WHERE id = $1 AND org_id = $2`, [depId, orgId, errorMessage(e).slice(0, 2000)]);
      await this.audit.record({ orgId, actor, action: 'deploy.local', targetType: 'deployment', targetId: depId, outcome: 'failed', details: { error: errorMessage(e) } });
      throw e;
    }
  }

  async stopDeployment(orgId: string, depId: string, actor: Actor) {
    await this.deployer.stop(depId);
    await this.db.query(`UPDATE deployments SET status = 'stopped', stopped_at = now(), updated_at = now() WHERE id = $1 AND org_id = $2`, [depId, orgId]);
    await this.audit.record({ orgId, actor, action: 'deploy.stop', targetType: 'deployment', targetId: depId });
    await this.events.publish(orgId, 'deployment.updated', { entityType: 'deployment', entityId: depId, payload: { status: 'stopped' } });
  }

  /**
   * Production deployment (approval executor). ROOS prepares a verified bundle and a checklist;
   * pushing to a hosting provider stays a manual, human-performed step until a provider
   * integration with its own credentials is configured.
   */
  async prepareProductionDeployment(orgId: string, projectId: string, approvalId: string, actor: Actor) {
    const project = await this.getProject(orgId, projectId);
    const depId = newId('deployment');
    const product = await this.db.one<Record<string, any>>('SELECT id, write_key FROM products WHERE org_id = $1 AND project_id = $2', [orgId, projectId]);
    const checklist = [
      `docker build -t ${project.slug} "${project.path}"`,
      'Push the image to your registry and deploy it (see deploy/README.md; fly.toml example included).',
      `Set ROOS_TRACK_URL=${this.cfg.api.publicUrl}/api/track and ROOS_WRITE_KEY=<product write key> in the hosting provider.`,
      'Point DNS / HTTPS at the service, then mark the product live in ROOS.',
    ];
    await this.db.query(`INSERT INTO deployments (id, org_id, project_id, product_id, environment, driver, status, approval_id, logs) VALUES ($1,$2,$3,$4,'production','manual','pending_manual',$5,$6)`, [
      depId,
      orgId,
      projectId,
      product?.id ?? null,
      approvalId,
      checklist.join('\n'),
    ]);
    await this.audit.record({ orgId, actor, action: 'deploy.production.prepare', targetType: 'deployment', targetId: depId, details: { approvalId } });
    return { deploymentId: depId, status: 'pending_manual', bundlePath: project.path, checklist };
  }

  async listDeployments(orgId: string) {
    const rows = (await this.db.many('SELECT * FROM deployments WHERE org_id = $1 ORDER BY created_at DESC LIMIT 100', [orgId])).map((r) => camelize<Record<string, any>>(r));
    // Reflect processes that died since the DB row was written.
    return rows.map((r) => (r.status === 'running' && r.environment === 'local' && !this.deployer.isRunning(r.id) ? { ...r, status: 'stopped', note: 'Process not running in this API instance' } : r));
  }

  /** On startup: local deployments from a previous process are no longer running. */
  async reconcileOnStartup() {
    await this.db.query(`UPDATE deployments SET status = 'stopped', stopped_at = now(), updated_at = now() WHERE environment = 'local' AND status IN ('running','starting')`);
  }
}
