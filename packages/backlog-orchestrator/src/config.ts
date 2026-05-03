import type { HarnessOrchestratorConfig } from './types';

export const DEMO_WORKFLOW_LABEL_TO_NAME: Record<string, string> = {
  'archon-workflow:test-loop': 'archon-test-loop-dag',
  'archon-workflow:tiny': 'archon-tiny',
  'archon-workflow:tiny-self-merge': 'archon-tiny-self-merge',
  'archon-workflow:video-recording': 'archon-video-recording',
};

export const DEMO_WORKFLOW_LABELS_COMPLETING_WITHOUT_PR = [
  'archon-workflow:video-recording',
] as const;

export function createDefaultHarnessConfig(
  overrides: Partial<HarnessOrchestratorConfig> = {}
): HarnessOrchestratorConfig {
  return {
    repo: 'owner/harness',
    baseBranch: undefined,
    maxParallelWorkflows: 1,
    maxOpenAgentPrs: 3,
    maxNewRunsPerCycle: 1,
    autoMergeEnabled: false,
    maxRunAttempts: 2,
    maxFixAttempts: 2,
    conflictWorkflowName: 'archon-resolve-conflicts',
    areaLockPolicy: 'conservative',
    workflowLabelToName: {
      'archon-workflow:ralph': 'archon-ralph-dag',
      'archon-workflow:fix-issue': 'archon-fix-github-issue',
      'archon-workflow:fix-issue-simple': 'archon-fix-github-issue-simple',
      'archon-workflow:review-pr': 'maintainer-review-pr',
      'archon-workflow:docs': 'docs-focused',
      'archon-workflow:refactor': 'archon-refactor-safely',
    },
    workflowLabelsCompletingWithoutPr: [],
    now: () => new Date(),
    ...overrides,
  };
}
