import type { ToolDefinition, ToolName } from './types';

/**
 * Tool catalogue. Agents may only call tools on their allow-list (stored per organisation in the
 * `agents` table, editable by admins). Tools bound to an `action` are checked against the policy
 * engine by the orchestrator on every call. Tools with `gate: 'service'` are enforced inside the
 * domain service, which builds the approval request with full context (cost, recipients, risk)
 * — the orchestrator does not add a second, generic approval.
 */
export const TOOLS: Record<ToolName, ToolDefinition & { gate?: 'service' }> = {
  'opportunity.read': { name: 'opportunity.read', description: 'Read opportunities, evidence and hypotheses', readOnly: true },
  'opportunity.write': { name: 'opportunity.write', description: 'Create/update opportunities, evidence and scores', action: 'opportunity.write', readOnly: false },
  'connectors.search': { name: 'connectors.search', description: 'Fetch public data from configured sources', action: 'research.fetch_public', readOnly: false },
  'analysis.run': { name: 'analysis.run', description: 'Market sizing, competition, hypotheses and unit economics', action: 'opportunity.write', readOnly: false },
  'hypothesis.select': { name: 'hypothesis.select', description: 'Select the business hypothesis to build', action: 'opportunity.write', readOnly: false },
  'code.generate': { name: 'code.generate', description: 'Generate an MVP and run its tests in the sandbox', action: 'code.generate', readOnly: false },
  'deploy.local': { name: 'deploy.local', description: 'Run a local preview deployment', action: 'deploy.local', readOnly: false },
  'deploy.production': { name: 'deploy.production', description: 'Request a production deployment (approval with full context)', action: 'deploy.production', readOnly: false, gate: 'service' },
  'experiment.manage': { name: 'experiment.manage', description: 'Create and start experiments (spend is approval-gated by the service)', action: 'experiment.start', readOnly: false, gate: 'service' },
  'experiment.evaluate': { name: 'experiment.evaluate', description: 'Evaluate experiments against pre-registered thresholds', readOnly: true },
  'leads.score': { name: 'leads.score', description: 'Score leads (no contact)', readOnly: true },
  'campaign.draft': { name: 'campaign.draft', description: 'Draft outreach messages (not sent)', readOnly: true },
  'campaign.send': { name: 'campaign.send', description: 'Request sending a campaign (approval with recipients and samples)', action: 'outreach.send', readOnly: false, gate: 'service' },
  'finance.analyze': { name: 'finance.analyze', description: 'Portfolio allocation and cash-flow projections (recommendations only)', readOnly: true },
  'report.generate': { name: 'report.generate', description: 'Generate reports from recorded data', readOnly: true },
  'strategy.learn': { name: 'strategy.learn', description: 'Recalibrate scoring weights from outcomes', readOnly: false },
  'security.audit': { name: 'security.audit', description: 'Verify audit chain and review security posture', readOnly: true },
  'alerts.raise': { name: 'alerts.raise', description: 'Raise alerts for humans', readOnly: false },
};
