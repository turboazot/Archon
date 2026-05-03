import { describe, expect, test } from 'bun:test';
import { createDefaultHarnessConfig } from '@archon/backlog-orchestrator';
import { backlogHarnessConfig } from './backlog';

describe('backlogHarnessConfig', () => {
  test('omits undefined fields so partial config cannot erase harness defaults', () => {
    const defaults = createDefaultHarnessConfig();
    const overrides = backlogHarnessConfig({
      repo: 'owner/repo',
      areaLockPolicy: 'none',
    });

    expect(Object.hasOwn(overrides, 'conflictWorkflowName')).toBe(false);
    expect(Object.hasOwn(overrides, 'maxRunAttempts')).toBe(false);
    expect(Object.hasOwn(overrides, 'maxFixAttempts')).toBe(false);

    expect(
      createDefaultHarnessConfig({
        ...overrides,
        repo: 'owner/repo',
      })
    ).toMatchObject({
      conflictWorkflowName: defaults.conflictWorkflowName,
      maxRunAttempts: defaults.maxRunAttempts,
      maxFixAttempts: defaults.maxFixAttempts,
      areaLockPolicy: 'none',
    });
  });

  test('preserves explicit false and empty array values', () => {
    const overrides = backlogHarnessConfig({
      repo: 'owner/repo',
      autoMergeEnabled: false,
      workflowLabelsCompletingWithoutPr: [],
    });

    expect(overrides).toMatchObject({
      autoMergeEnabled: false,
      workflowLabelsCompletingWithoutPr: [],
    });
  });
});
