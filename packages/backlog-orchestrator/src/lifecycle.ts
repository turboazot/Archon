import type { OrchestratorRunStatus } from './types';

export const WORKFLOW_LABEL_PREFIX = 'archon-workflow:';

export const LIFECYCLE_LABELS = {
  ready: 'archon:ready',
  inProgress: 'archon:in-progress',
  blocked: 'archon:blocked',
  prOpen: 'archon:pr-open',
  readyForReview: 'archon:ready-for-review',
  needsFix: 'archon:needs-fix',
  done: 'archon:done',
  autoMerge: 'archon:auto-merge',
} as const;

export const TERMINAL_RUN_STATUSES = new Set<OrchestratorRunStatus>([
  'done',
  'failed',
  'abandoned',
]);

export const ACTIVE_RUN_STATUSES = new Set<OrchestratorRunStatus>([
  'running',
  'fix_running',
  'conflict_running',
]);
