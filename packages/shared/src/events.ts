/**
 * Event types flowing through the event bus. Events are persisted to the `events` table
 * (append-only log) and streamed to the dashboard over SSE.
 */
export const EVENT_TYPES = [
  'opportunity.created',
  'opportunity.updated',
  'opportunity.scored',
  'hypothesis.created',
  'task.queued',
  'task.started',
  'task.succeeded',
  'task.failed',
  'task.waiting_approval',
  'approval.requested',
  'approval.decided',
  'approval.executed',
  'experiment.created',
  'experiment.started',
  'experiment.evaluated',
  'experiment.decided',
  'project.generated',
  'sandbox.completed',
  'deployment.updated',
  'tracking.event',
  'lead.created',
  'campaign.updated',
  'revenue.recorded',
  'expense.recorded',
  'report.generated',
  'research.completed',
  'alert',
  'system.health',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export type AlertSeverity = 'info' | 'warning' | 'critical';
