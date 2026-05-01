import type { HarnessOrchestratorConfig } from './types';

export function createDefaultHarnessConfig(
  overrides: Partial<HarnessOrchestratorConfig> = {}
): HarnessOrchestratorConfig {
  return {
    repo: 'owner/harness',
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
      'archon-workflow:test-loop': 'archon-test-loop-dag',
      'archon-workflow:refactor': 'archon-refactor-safely',
      'archon-workflow:e2e-tiny': 'archon-e2e-tiny',
      'archon-workflow:e2e-tiny-self-merge': 'archon-e2e-tiny-self-merge',
    },
    now: () => new Date(),
    ...overrides,
  };
}
