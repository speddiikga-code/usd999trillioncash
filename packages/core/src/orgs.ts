import type { Db } from '@roos/database';
import { json } from '@roos/database';
import { camelize, newId, NotFoundError, ONBOARDING_STEPS, randomToken, slugify, type OnboardingStep, type Organization, type OrgSettings } from '@roos/shared';

export const DEMO_ORG_SLUG = 'demo-workspace';

/**
 * Mark a first-run onboarding step as done (single atomic statement; no-op if already done).
 * Called by services when the underlying milestone really happens.
 */
export async function markStep(db: Db, orgId: string, step: OnboardingStep): Promise<void> {
  await db.query(
    `UPDATE organizations SET settings = jsonb_set(settings, '{onboarding}',
       COALESCE(settings->'onboarding', '{}'::jsonb) || jsonb_build_object($2::text, jsonb_build_object('done', true, 'at', to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))))
     WHERE id = $1 AND NOT COALESCE((settings->'onboarding'->$2::text->>'done')::boolean, false)`,
    [orgId, step],
  );
}

export class OrgService {
  constructor(private db: Db) {}

  async create(name: string, opts: { isDemo?: boolean; slug?: string } = {}): Promise<Organization> {
    const id = newId('org');
    const slug = opts.slug ?? `${slugify(name, 32)}-${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
    const row = await this.db.one(`INSERT INTO organizations (id, name, slug, is_demo, settings) VALUES ($1, $2, $3, $4, $5) RETURNING *`, [id, name, slug, !!opts.isDemo, json({})]);
    return camelize<Organization>(row!);
  }

  async get(orgId: string): Promise<Organization> {
    const row = await this.db.one('SELECT * FROM organizations WHERE id = $1', [orgId]);
    if (!row) throw new NotFoundError('Organization', orgId);
    return camelize<Organization>(row);
  }

  async getBySlug(slug: string): Promise<Organization | null> {
    const row = await this.db.one('SELECT * FROM organizations WHERE slug = $1', [slug]);
    return row ? camelize<Organization>(row) : null;
  }

  async demoOrg(): Promise<Organization | null> {
    return this.getBySlug(DEMO_ORG_SLUG);
  }

  async updateSettings(orgId: string, patch: Partial<OrgSettings> & { name?: string }): Promise<Organization> {
    const org = await this.get(orgId);
    const { name, ...settingsPatch } = patch;
    const merged: OrgSettings = { ...org.settings, ...settingsPatch };
    if (settingsPatch.constraints) merged.constraints = { ...(org.settings.constraints ?? {}), ...settingsPatch.constraints };
    const row = await this.db.one(`UPDATE organizations SET settings = $2, name = COALESCE($3, name), updated_at = now() WHERE id = $1 RETURNING *`, [orgId, json(merged), name ?? null]);
    return camelize<Organization>(row!);
  }

  async markOnboarding(orgId: string, step: OnboardingStep | string, done = true): Promise<Organization> {
    if (!(ONBOARDING_STEPS as readonly string[]).includes(step)) throw new NotFoundError('Onboarding step', step);
    const org = await this.get(orgId);
    const onboarding = { ...(org.settings.onboarding ?? {}), [step]: { done, at: new Date().toISOString() } };
    return this.updateSettings(orgId, { onboarding });
  }

  onboardingState(org: Organization) {
    const state = org.settings.onboarding ?? {};
    const steps = ONBOARDING_STEPS.map((s) => ({ step: s, done: !!state[s]?.done, at: state[s]?.at }));
    const next = steps.find((s) => !s.done)?.step ?? null;
    return { steps, next, complete: next === null };
  }
}
