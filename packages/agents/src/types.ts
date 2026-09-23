import type { CallContext, ModelRouter } from '@roos/ai';
import type { Actor, Core } from '@roos/core';
import type { ActionKey, AgentName, AgentTask, Logger } from '@roos/shared';

export interface AgentBudget {
  maxCostPerTaskUsd: number;
  dailyCostUsd: number;
}

export interface RetryPolicy {
  maxAttempts: number;
  backoffMs: number;
  factor: number;
}

export interface NextTask {
  agent: AgentName;
  kind: string;
  input: Record<string, unknown>;
  priority?: number;
  delayMs?: number;
}

export interface MemoryWrite {
  kind: 'fact' | 'lesson' | 'preference' | 'summary' | 'warning';
  content: string;
  scope?: string;
  data?: Record<string, unknown>;
  importance?: number;
}

export interface TaskResult {
  output: Record<string, unknown>;
  next?: NextTask[];
  memory?: MemoryWrite[];
}

export interface MemoryItem {
  kind: string;
  content: string;
  scope: string | null;
  data: Record<string, unknown>;
  importance: number;
  createdAt: string;
}

export interface AgentContext {
  orgId: string;
  task: AgentTask;
  agent: AgentDefinition;
  actor: Actor;
  core: Core;
  /** Permission-checked, policy-checked, audited, traced tool invocation. */
  tool<T>(name: ToolName, args: Record<string, unknown>, run: () => Promise<T>): Promise<T>;
  /** Null when no AI provider is configured or model calls are not permitted. */
  router: ModelRouter | null;
  callCtx: CallContext;
  memory: { recall(scope?: string | null, limit?: number): Promise<MemoryItem[]> };
  span<T>(name: string, fn: () => Promise<T>, attrs?: Record<string, unknown>): Promise<T>;
  log: Logger;
  signal: AbortSignal;
  /** Set when the task resumes after a human approved its approval request. */
  approvalId: string | null;
}

export type TaskHandler = (ctx: AgentContext, input: Record<string, any>) => Promise<TaskResult>;

export interface AgentDefinition {
  name: AgentName;
  description: string;
  tools: ToolName[];
  budget: AgentBudget;
  timeoutMs: number;
  retry: RetryPolicy;
  modelTier: 'fast' | 'balanced' | 'deep';
  handlers: Record<string, TaskHandler>;
}

export interface ToolDefinition {
  name: ToolName;
  description: string;
  /** Policy action checked before every call (undefined = read-only / analysis). */
  action?: ActionKey;
  readOnly: boolean;
}

export type ToolName =
  | 'opportunity.read'
  | 'opportunity.write'
  | 'connectors.search'
  | 'analysis.run'
  | 'hypothesis.select'
  | 'code.generate'
  | 'deploy.local'
  | 'deploy.production'
  | 'experiment.manage'
  | 'experiment.evaluate'
  | 'leads.score'
  | 'campaign.draft'
  | 'campaign.send'
  | 'finance.analyze'
  | 'report.generate'
  | 'strategy.learn'
  | 'security.audit'
  | 'alerts.raise';
