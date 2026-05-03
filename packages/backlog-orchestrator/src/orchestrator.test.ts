import { describe, expect, test } from 'bun:test';
import {
  HarnessOrchestrator,
  DEMO_WORKFLOW_LABELS_COMPLETING_WITHOUT_PR,
  DEMO_WORKFLOW_LABEL_TO_NAME,
  createDefaultHarnessConfig,
  type HarnessOrchestratorConfig,
} from './orchestrator';
import {
  InMemoryArchon,
  InMemoryGitHub,
  InMemoryOrchestratorStore,
  makeIssue,
  makePullRequest,
} from './mocks';

const repo = 'owner/harness';
const fixedNow = new Date('2026-04-30T00:00:00.000Z');
const demoWorkflowConfig = {
  workflowLabelToName: {
    ...createDefaultHarnessConfig().workflowLabelToName,
    ...DEMO_WORKFLOW_LABEL_TO_NAME,
  },
  workflowLabelsCompletingWithoutPr: [...DEMO_WORKFLOW_LABELS_COMPLETING_WITHOUT_PR],
};

function createHarness(
  input: ConstructorParameters<typeof InMemoryGitHub>[0],
  configOverrides: Partial<HarnessOrchestratorConfig> = {}
): {
  github: InMemoryGitHub;
  archon: InMemoryArchon;
  store: InMemoryOrchestratorStore;
  orchestrator: HarnessOrchestrator;
} {
  const github = new InMemoryGitHub(input);
  const archon = new InMemoryArchon();
  const store = new InMemoryOrchestratorStore();
  const orchestrator = new HarnessOrchestrator(
    createDefaultHarnessConfig({
      repo,
      now: () => fixedNow,
      ...configOverrides,
    }),
    { github, archon, store }
  );

  return { github, archon, store, orchestrator };
}

describe('HarnessOrchestrator', () => {
  test('scenario 1: starts a ready issue with exactly one workflow label', async () => {
    const { github, archon, store, orchestrator } = createHarness({
      issues: [
        makeIssue({
          number: 1,
          labels: ['archon:ready', 'archon-workflow:fix-issue', 'area:products'],
        }),
      ],
    });

    const report = await orchestrator.reconcileOnce();
    const issue = await github.getIssue(repo, 1);
    const runs = await store.listRuns(repo);

    expect(report.startedRuns).toHaveLength(1);
    expect(archon.getStartedRuns()[0]?.workflowName).toBe('archon-fix-github-issue');
    expect(issue?.labels).toContain('archon:in-progress');
    expect(issue?.labels).not.toContain('archon:ready');
    expect(runs[0]?.status).toBe('running');
    expect(github.getComments(1)[0]?.body).toContain('Started archon-fix-github-issue');
  });

  test('starts the video recording workflow from its routing label', async () => {
    const { archon, orchestrator } = createHarness(
      {
        issues: [
          makeIssue({
            number: 1,
            labels: ['archon:ready', 'archon-workflow:video-recording', 'area:test'],
          }),
        ],
      },
      demoWorkflowConfig
    );

    await orchestrator.reconcileOnce();

    expect(archon.getStartedRuns()[0]?.workflowName).toBe('archon-video-recording');
  });

  test('marks configured PR-less workflows done after successful completion', async () => {
    const { archon, github, store, orchestrator } = createHarness(
      {
        issues: [
          makeIssue({
            number: 1,
            labels: ['archon:ready', 'archon-workflow:video-recording', 'area:test'],
          }),
        ],
      },
      demoWorkflowConfig
    );

    await orchestrator.reconcileOnce();
    const workflowRun = archon.getStartedRuns()[0];
    if (!workflowRun) throw new Error('Expected workflow run to start');
    archon.completeRun(workflowRun.id, 'succeeded');

    await orchestrator.reconcileOnce();

    const runs = await store.listRuns(repo);
    const issue = await github.getIssue(repo, 1);
    expect(runs[0]?.status).toBe('done');
    expect(issue?.labels).toContain('archon:done');
    expect(issue?.labels).not.toContain('archon:blocked');
    expect(github.getComments(1).some(comment => comment.body.includes('without a PR'))).toBe(true);
  });

  test('scenario 2: blocks a ready issue with no workflow label', async () => {
    const { github, archon, orchestrator } = createHarness({
      issues: [makeIssue({ number: 1, labels: ['archon:ready'] })],
    });

    const report = await orchestrator.reconcileOnce();
    const issue = await github.getIssue(repo, 1);

    expect(report.blockedIssues.map(blocked => blocked.reason)).toEqual([
      'Missing archon-workflow:* routing label',
    ]);
    expect(issue?.labels).toContain('archon:blocked');
    expect(github.getComments(1).map(comment => comment.body)).toEqual([
      'Missing archon-workflow:* routing label',
    ]);
    expect(archon.getStartedRuns()).toHaveLength(0);
  });

  test('scenario 3: blocks a ready issue with multiple workflow labels', async () => {
    const { github, archon, orchestrator } = createHarness({
      issues: [
        makeIssue({
          number: 1,
          labels: ['archon:ready', 'archon-workflow:fix-issue', 'archon-workflow:docs'],
        }),
      ],
    });

    const report = await orchestrator.reconcileOnce();
    const issue = await github.getIssue(repo, 1);

    expect(report.blockedIssues.map(blocked => blocked.reason)).toEqual([
      'Ambiguous workflow routing labels',
    ]);
    expect(issue?.labels).toContain('archon:blocked');
    expect(github.getComments(1).map(comment => comment.body)).toEqual([
      'Ambiguous workflow routing labels',
    ]);
    expect(archon.getStartedRuns()).toHaveLength(0);
  });

  test('scenario 4: leaves dependency-blocked issues to GitHub native blockers', async () => {
    const { github, archon, orchestrator } = createHarness({
      issues: [
        makeIssue({ number: 1, labels: [] }),
        makeIssue({
          number: 2,
          labels: ['archon:ready', 'archon-workflow:docs', 'area:docs'],
          blockedByIssueNumbers: [1],
        }),
      ],
    });

    await orchestrator.reconcileOnce();
    const report = await orchestrator.reconcileOnce();
    const issue = await github.getIssue(repo, 2);

    expect(report.blockedIssues.map(blocked => blocked.issue.number)).toEqual([2]);
    expect(report.blockedIssues[0]?.reason).toBe('Blocked by open issue(s): 1');
    expect(issue?.labels).not.toContain('archon:blocked');
    expect(github.getComments(2)).toHaveLength(0);
    expect(archon.getStartedRuns()).toHaveLength(0);
  });

  test('scenario 5: reports eligible issues as waiting when WIP limit is reached', async () => {
    const { github, orchestrator } = createHarness(
      {
        issues: [
          makeIssue({
            number: 1,
            labels: ['archon:ready', 'archon-workflow:fix-issue'],
          }),
          makeIssue({
            number: 2,
            labels: ['archon:ready', 'archon-workflow:docs'],
          }),
        ],
      },
      { areaLockPolicy: 'none', maxParallelWorkflows: 1, maxNewRunsPerCycle: 2 }
    );

    const report = await orchestrator.reconcileOnce();
    const waitingIssue = await github.getIssue(repo, 2);

    expect(report.startedRuns.map(run => run.issueNumber)).toEqual([1]);
    expect(report.waitingForCapacity.map(issue => issue.number)).toEqual([2]);
    expect(waitingIssue?.labels).not.toContain('archon:blocked');
  });

  test('scenario 6: blocks an eligible issue that conflicts with an active area lock', async () => {
    const { github, orchestrator } = createHarness({
      issues: [
        makeIssue({
          number: 1,
          labels: ['archon:ready', 'archon-workflow:fix-issue', 'area:products'],
        }),
        makeIssue({
          number: 2,
          labels: ['archon:ready', 'archon-workflow:fix-issue', 'area:products'],
        }),
      ],
    });

    await orchestrator.reconcileOnce();
    const secondReport = await orchestrator.reconcileOnce();
    const issue = await github.getIssue(repo, 2);

    expect(secondReport.blockedIssues.map(blocked => blocked.issue.number)).toEqual([2]);
    expect(secondReport.blockedIssues[0]?.reason).toBe('Blocked by area lock conflict');
    expect(issue?.labels).toContain('archon:blocked');
  });

  test('scenario 7: fails a successful workflow when no PR appears', async () => {
    const { github, archon, store, orchestrator } = createHarness(
      {
        issues: [
          makeIssue({
            number: 1,
            labels: ['archon:ready', 'archon-workflow:fix-issue'],
          }),
        ],
      },
      {
        maxRunAttempts: 1,
      }
    );

    await orchestrator.reconcileOnce();
    const workflowRun = archon.getStartedRuns()[0];
    archon.completeRun(workflowRun.id, 'succeeded');

    await orchestrator.reconcileOnce();
    const issue = await github.getIssue(repo, 1);
    const runs = await store.listRuns(repo);

    expect(runs[0]?.status).toBe('failed');
    expect(runs[0]?.lastError).toContain('no PR was found');
    expect(issue?.labels).toContain('archon:blocked');
    expect(github.getComments(1).some(comment => comment.body.includes('no PR was found'))).toBe(
      true
    );
  });

  test('scenario 8: records workflow terminal failure and removes active label', async () => {
    const { github, archon, store, orchestrator } = createHarness(
      {
        issues: [
          makeIssue({
            number: 1,
            labels: ['archon:ready', 'archon-workflow:fix-issue'],
          }),
        ],
      },
      {
        maxRunAttempts: 1,
      }
    );

    await orchestrator.reconcileOnce();
    const workflowRun = archon.getStartedRuns()[0];
    archon.completeRun(workflowRun.id, 'failed', 'validation command failed');

    await orchestrator.reconcileOnce();
    const issue = await github.getIssue(repo, 1);
    const runs = await store.listRuns(repo);

    expect(runs[0]?.status).toBe('failed');
    expect(runs[0]?.lastError).toBe('validation command failed');
    expect(issue?.labels).not.toContain('archon:in-progress');
    expect(issue?.labels).toContain('archon:blocked');
    expect(github.getComments(1)[1]?.body).toContain('validation command failed');
  });

  test('scenario 8b: retries a failed implementation workflow before blocking issue', async () => {
    const { github, archon, store, orchestrator } = createHarness({
      issues: [
        makeIssue({
          number: 1,
          labels: ['archon:ready', 'archon-workflow:fix-issue'],
        }),
      ],
    });

    await orchestrator.reconcileOnce();
    const firstWorkflowRun = archon.getStartedRuns()[0];
    archon.completeRun(firstWorkflowRun.id, 'cancelled', 'worker interrupted');

    await orchestrator.reconcileOnce();
    const runs = await store.listRuns(repo);
    const issue = await github.getIssue(repo, 1);
    const startedRuns = archon.getStartedRuns();

    expect(startedRuns).toHaveLength(2);
    expect(runs[0]?.workflowRunId).toBe(startedRuns[1]?.id);
    expect(runs[0]?.status).toBe('running');
    expect(runs[0]?.runAttempts).toBe(2);
    expect(runs[0]?.lastError).toBe('worker interrupted');
    expect(issue?.labels).toContain('archon:in-progress');
    expect(issue?.labels).not.toContain('archon:blocked');
    expect(github.getComments(1).some(comment => comment.body.includes('Attempt 2 of 2'))).toBe(
      true
    );
  });

  test('scenario 9: stores PR number and changed files when a workflow opens a PR', async () => {
    const { github, archon, store, orchestrator } = createHarness({
      issues: [
        makeIssue({
          number: 1,
          labels: ['archon:ready', 'archon-workflow:fix-issue', 'area:products'],
        }),
      ],
    });

    await orchestrator.reconcileOnce();
    const workflowRun = archon.getStartedRuns()[0];
    archon.completeRun(workflowRun.id, 'succeeded');
    github.addPullRequest(
      makePullRequest({
        number: 10,
        issueNumber: 1,
        branch: workflowRun.branch,
        changedFiles: ['src/products.ts'],
      })
    );

    await orchestrator.reconcileOnce();
    const runs = await store.listRuns(repo);
    const issue = await github.getIssue(repo, 1);

    expect(runs[0]?.prNumber).toBe(10);
    expect(runs[0]?.status).toBe('pr_open');
    expect(runs[0]?.changedFiles).toEqual(['src/products.ts']);
    expect(issue?.labels).toContain('archon:pr-open');
    expect(github.getComments(1).some(comment => comment.body.includes('PR #10 is open'))).toBe(
      true
    );
  });

  test('scenario 10: marks a validated PR ready for review', async () => {
    const { github, archon, store, orchestrator } = createHarness({
      issues: [
        makeIssue({
          number: 1,
          labels: ['archon:ready', 'archon-workflow:fix-issue', 'area:products'],
        }),
      ],
    });

    await orchestrator.reconcileOnce();
    const workflowRun = archon.getStartedRuns()[0];
    archon.completeRun(workflowRun.id, 'succeeded');
    github.addPullRequest(
      makePullRequest({
        number: 10,
        issueNumber: 1,
        branch: workflowRun.branch,
        checks: 'passing',
        changedFiles: ['src/products.ts'],
      })
    );

    await orchestrator.reconcileOnce();
    const report = await orchestrator.reconcileOnce();
    const runs = await store.listRuns(repo);
    const issue = await github.getIssue(repo, 1);

    expect(runs[0]?.status).toBe('ready_for_review');
    expect(issue?.labels).not.toContain('archon:in-progress');
    expect(issue?.labels).toContain('archon:ready-for-review');
    expect(report.readyForHumanReview.map(pr => pr.number)).toEqual([10]);
  });

  test('scenario 11: schedules one fix workflow when checks fail', async () => {
    const { github, archon, store, orchestrator } = createHarness({
      issues: [
        makeIssue({
          number: 1,
          labels: ['archon:ready', 'archon-workflow:fix-issue'],
        }),
      ],
    });

    await orchestrator.reconcileOnce();
    const workflowRun = archon.getStartedRuns()[0];
    archon.completeRun(workflowRun.id, 'succeeded');
    github.addPullRequest(
      makePullRequest({
        number: 10,
        issueNumber: 1,
        branch: workflowRun.branch,
        checks: 'failing',
      })
    );

    await orchestrator.reconcileOnce();
    await orchestrator.reconcileOnce();
    await orchestrator.reconcileOnce();
    await orchestrator.reconcileOnce();
    const runs = await store.listRuns(repo);
    const issue = await github.getIssue(repo, 1);

    expect(archon.getStartedRuns()).toHaveLength(2);
    expect(archon.getStartedRuns()[1]?.workflowName).toBe('fix-pr');
    expect(runs[0]?.status).toBe('fix_running');
    expect(runs[0]?.fixAttempts).toBe(1);
    expect(issue?.labels).toContain('archon:needs-fix');
    expect(
      github.getComments(1).some(comment => comment.body.includes('Scheduled fix attempt 1'))
    ).toBe(true);
  });

  test('scenario 12: schedules fix workflow when a human requests changes', async () => {
    const { github, archon, store, orchestrator } = createHarness({
      issues: [
        makeIssue({
          number: 1,
          labels: ['archon:ready', 'archon-workflow:fix-issue'],
        }),
      ],
    });

    await orchestrator.reconcileOnce();
    const workflowRun = archon.getStartedRuns()[0];
    archon.completeRun(workflowRun.id, 'succeeded');
    github.addPullRequest(
      makePullRequest({
        number: 10,
        issueNumber: 1,
        branch: workflowRun.branch,
        checks: 'passing',
        review: 'changes_requested',
      })
    );

    await orchestrator.reconcileOnce();
    await orchestrator.reconcileOnce();
    await orchestrator.reconcileOnce();
    const runs = await store.listRuns(repo);

    expect(archon.getStartedRuns()[1]?.workflowName).toBe('fix-pr');
    expect(runs[0]?.status).toBe('fix_running');
    expect(runs[0]?.lastError).toBe('Review requested changes');
  });

  test('scenario 12b: schedules conflict workflow when an open PR has merge conflicts', async () => {
    const { github, archon, store, orchestrator } = createHarness({
      issues: [
        makeIssue({
          number: 1,
          labels: ['archon:ready', 'archon-workflow:fix-issue'],
        }),
      ],
    });

    await orchestrator.reconcileOnce();
    const workflowRun = archon.getStartedRuns()[0];
    archon.completeRun(workflowRun.id, 'succeeded');
    github.addPullRequest(
      makePullRequest({
        number: 10,
        issueNumber: 1,
        branch: workflowRun.branch,
        checks: 'passing',
        mergeable: false,
        mergeability: 'conflicting',
      })
    );

    await orchestrator.reconcileOnce();
    await orchestrator.reconcileOnce();
    await orchestrator.reconcileOnce();
    const runs = await store.listRuns(repo);
    const issue = await github.getIssue(repo, 1);

    expect(archon.getStartedRuns()).toHaveLength(2);
    expect(archon.getStartedRuns()[1]?.workflowName).toBe('archon-resolve-conflicts');
    expect(runs[0]?.status).toBe('conflict_running');
    expect(runs[0]?.fixAttempts).toBe(1);
    expect(runs[0]?.lastError).toBe('PR #10 has merge conflicts');
    expect(issue?.labels).toContain('archon:needs-fix');
    expect(
      github
        .getComments(1)
        .some(comment => comment.body.includes('Scheduled conflict resolution attempt 1'))
    ).toBe(true);
  });

  test('does not schedule conflict workflow while implementation workflow is still running', async () => {
    const { github, archon, store, orchestrator } = createHarness({
      issues: [
        makeIssue({
          number: 1,
          labels: ['archon:ready', 'archon-workflow:fix-issue-simple'],
        }),
      ],
    });

    await orchestrator.reconcileOnce();
    const implementationRun = archon.getStartedRuns()[0];
    github.addPullRequest(
      makePullRequest({
        number: 10,
        issueNumber: 1,
        branch: implementationRun.branch,
        checks: 'passing',
        mergeable: false,
        mergeability: 'conflicting',
      })
    );

    await orchestrator.reconcileOnce();
    const runs = await store.listRuns(repo);

    expect(archon.getStartedRuns()).toHaveLength(1);
    expect(runs[0]?.status).toBe('running');
    expect(runs[0]?.prNumber).toBeUndefined();
  });

  test('retries a cancelled conflict workflow against the existing PR', async () => {
    const { github, archon, store, orchestrator } = createHarness({
      issues: [
        makeIssue({
          number: 1,
          labels: ['archon:ready', 'archon-workflow:fix-issue-simple'],
        }),
      ],
    });

    await orchestrator.reconcileOnce();
    const implementationRun = archon.getStartedRuns()[0];
    archon.completeRun(implementationRun.id, 'succeeded');
    github.addPullRequest(
      makePullRequest({
        number: 10,
        issueNumber: 1,
        branch: implementationRun.branch,
        checks: 'passing',
        mergeable: false,
        mergeability: 'conflicting',
      })
    );

    await orchestrator.reconcileOnce();
    const firstConflictRun = archon.getStartedRuns()[1];
    archon.completeRun(firstConflictRun.id, 'cancelled', 'Workflow already active on this path');

    await orchestrator.reconcileOnce();
    const runs = await store.listRuns(repo);
    const startedRuns = archon.getStartedRuns();

    expect(startedRuns.map(run => run.workflowName)).toEqual([
      'archon-fix-github-issue-simple',
      'archon-resolve-conflicts',
      'archon-resolve-conflicts',
    ]);
    expect(startedRuns[2]?.branch).toBe(implementationRun.branch);
    expect(runs[0]?.prNumber).toBe(10);
    expect(runs[0]?.status).toBe('conflict_running');
    expect(runs[0]?.workflowRunId).toBe(startedRuns[2]?.id);
    expect(runs[0]?.fixAttempts).toBe(2);
    expect(runs[0]?.lastError).toBe('Workflow already active on this path');
  });

  test('retries conflict workflow when the tracked workflow record is missing', async () => {
    const { archon, store, orchestrator } = createHarness({
      issues: [
        makeIssue({
          number: 1,
          labels: ['archon:in-progress', 'archon-workflow:fix-issue-simple'],
        }),
      ],
      pullRequests: [
        makePullRequest({
          number: 10,
          issueNumber: 1,
          branch: 'archon/issue-1',
          checks: 'passing',
          mergeable: false,
          mergeability: 'conflicting',
        }),
      ],
    });

    await store.createRun({
      id: 'orchestrator-missing-conflict-run',
      repo,
      issueNumber: 1,
      workflowRunId: 'missing-conflict-workflow',
      branch: 'archon/issue-1',
      prNumber: 10,
      status: 'conflict_running',
      workflowLabel: 'archon-workflow:fix-issue-simple',
      areaLabels: [],
      changedFiles: [],
      startedAt: fixedNow,
      updatedAt: fixedNow,
      lastError: 'PR #10 has merge conflicts',
      runAttempts: 1,
      fixAttempts: 1,
      commentKeys: ['conflict-1'],
    });

    await orchestrator.reconcileOnce();
    const runs = await store.listRuns(repo);
    const startedRuns = archon.getStartedRuns();

    expect(startedRuns).toHaveLength(1);
    expect(startedRuns[0]?.workflowName).toBe('archon-resolve-conflicts');
    expect(startedRuns[0]?.branch).toBe('archon/issue-1');
    expect(runs[0]?.status).toBe('conflict_running');
    expect(runs[0]?.workflowRunId).toBe(startedRuns[0]?.id);
    expect(runs[0]?.fixAttempts).toBe(2);
    expect(runs[0]?.lastError).toBe('Conflict workflow record missing');
  });

  test('scenario 12c: resumes PR validation after conflict workflow completes', async () => {
    const { github, archon, store, orchestrator } = createHarness({
      issues: [
        makeIssue({
          number: 1,
          labels: ['archon:ready', 'archon-workflow:fix-issue'],
        }),
      ],
    });

    await orchestrator.reconcileOnce();
    const implementationRun = archon.getStartedRuns()[0];
    archon.completeRun(implementationRun.id, 'succeeded');
    github.addPullRequest(
      makePullRequest({
        number: 10,
        issueNumber: 1,
        branch: implementationRun.branch,
        checks: 'passing',
        mergeable: false,
        mergeability: 'conflicting',
      })
    );

    await orchestrator.reconcileOnce();
    await orchestrator.reconcileOnce();
    const conflictRun = archon.getStartedRuns()[1];
    archon.completeRun(conflictRun.id, 'succeeded');
    github.updatePullRequest(10, { mergeable: true, mergeability: 'mergeable' });

    await orchestrator.reconcileOnce();
    const runs = await store.listRuns(repo);

    expect(runs[0]?.status).toBe('ready_for_review');
    expect(runs[0]?.prNumber).toBe(10);
  });

  test('scenario 12d: handles merge-step failure when the workflow already opened a conflicting PR', async () => {
    const { github, archon, store, orchestrator } = createHarness({
      issues: [
        makeIssue({
          number: 1,
          labels: ['archon:ready', 'archon-workflow:fix-issue-simple', 'archon:auto-merge'],
        }),
      ],
    });

    await orchestrator.reconcileOnce();
    const implementationRun = archon.getStartedRuns()[0];
    github.addPullRequest(
      makePullRequest({
        number: 10,
        issueNumber: 1,
        branch: implementationRun.branch,
        checks: 'passing',
        mergeable: false,
        mergeability: 'conflicting',
      })
    );
    archon.completeRun(implementationRun.id, 'failed', 'Pull request is not mergeable');

    await orchestrator.reconcileOnce();
    await orchestrator.reconcileOnce();
    const runs = await store.listRuns(repo);
    const issue = await github.getIssue(repo, 1);

    expect(archon.getStartedRuns()).toHaveLength(2);
    expect(archon.getStartedRuns()[1]?.workflowName).toBe('archon-resolve-conflicts');
    expect(runs[0]?.status).toBe('conflict_running');
    expect(runs[0]?.lastError).toBe('PR #10 has merge conflicts');
    expect(issue?.labels).toContain('archon:needs-fix');
  });

  test('scenario 12e: auto-merges after conflict workflow resolves an eligible PR', async () => {
    const { github, archon, store, orchestrator } = createHarness(
      {
        issues: [
          makeIssue({
            number: 1,
            labels: ['archon:ready', 'archon-workflow:fix-issue-simple', 'archon:auto-merge'],
          }),
        ],
      },
      { autoMergeEnabled: true }
    );

    await orchestrator.reconcileOnce();
    const implementationRun = archon.getStartedRuns()[0];
    github.addPullRequest(
      makePullRequest({
        number: 10,
        issueNumber: 1,
        branch: implementationRun.branch,
        checks: 'passing',
        mergeable: false,
        mergeability: 'conflicting',
      })
    );
    archon.completeRun(implementationRun.id, 'failed', 'Pull request is not mergeable');

    await orchestrator.reconcileOnce();
    await orchestrator.reconcileOnce();
    const conflictRun = archon.getStartedRuns()[1];
    archon.completeRun(conflictRun.id, 'succeeded');
    github.updatePullRequest(10, { mergeable: true, mergeability: 'mergeable' });

    const mergeReport = await orchestrator.reconcileOnce();
    await orchestrator.reconcileOnce();
    const prs = await github.listPullRequests(repo);
    const runs = await store.listRuns(repo);

    expect(mergeReport.autoMergeCandidates.map(pr => pr.number)).toEqual([10]);
    expect(prs[0]?.state).toBe('merged');
    expect(runs[0]?.status).toBe('done');
  });

  test('scenario 13: approved PR without auto-merge waits for human merge', async () => {
    const { github, archon, orchestrator } = createHarness({
      issues: [
        makeIssue({
          number: 1,
          labels: ['archon:ready', 'archon-workflow:docs'],
        }),
      ],
    });

    await orchestrator.reconcileOnce();
    const workflowRun = archon.getStartedRuns()[0];
    archon.completeRun(workflowRun.id, 'succeeded');
    github.addPullRequest(
      makePullRequest({
        number: 10,
        issueNumber: 1,
        branch: workflowRun.branch,
        checks: 'passing',
        review: 'approved',
      })
    );

    const report = await orchestrator.reconcileOnce();
    const prs = await github.listPullRequests(repo);

    expect(report.readyForHumanReview.map(pr => pr.number)).toEqual([10]);
    expect(report.autoMergeCandidates).toHaveLength(0);
    expect(prs[0]?.state).toBe('open');
  });

  test('scenario 14: auto-merges eligible PRs and marks done after GitHub reports merged', async () => {
    const { github, archon, store, orchestrator } = createHarness(
      {
        issues: [
          makeIssue({
            number: 1,
            labels: ['archon:ready', 'archon-workflow:docs', 'archon:auto-merge'],
          }),
        ],
      },
      { autoMergeEnabled: true }
    );

    await orchestrator.reconcileOnce();
    const workflowRun = archon.getStartedRuns()[0];
    archon.completeRun(workflowRun.id, 'succeeded');
    github.addPullRequest(
      makePullRequest({
        number: 10,
        issueNumber: 1,
        branch: workflowRun.branch,
        checks: 'passing',
        review: 'approved',
      })
    );

    const mergeReport = await orchestrator.reconcileOnce();
    await orchestrator.reconcileOnce();
    const prs = await github.listPullRequests(repo);
    const runs = await store.listRuns(repo);
    const issue = await github.getIssue(repo, 1);

    expect(mergeReport.autoMergeCandidates.map(pr => pr.number)).toEqual([10]);
    expect(prs[0]?.state).toBe('merged');
    expect(runs[0]?.status).toBe('done');
    expect(issue?.labels).toContain('archon:done');
    expect(github.getComments(1).some(comment => comment.body.includes('was merged'))).toBe(true);
  });

  test('auto-merge label only reports candidates when global auto-merge is disabled', async () => {
    const { github, archon, orchestrator } = createHarness({
      issues: [
        makeIssue({
          number: 1,
          labels: ['archon:ready', 'archon-workflow:docs', 'archon:auto-merge'],
        }),
      ],
    });

    await orchestrator.reconcileOnce();
    const workflowRun = archon.getStartedRuns()[0];
    archon.completeRun(workflowRun.id, 'succeeded');
    github.addPullRequest(
      makePullRequest({
        number: 10,
        issueNumber: 1,
        branch: workflowRun.branch,
        checks: 'passing',
        review: 'approved',
      })
    );

    const report = await orchestrator.reconcileOnce();
    const prs = await github.listPullRequests(repo);

    expect(report.autoMergeCandidates.map(pr => pr.number)).toEqual([10]);
    expect(prs[0]?.state).toBe('open');
  });

  test('blocks auto-merge candidate when PR base is not the GitHub default branch', async () => {
    const { github, archon, orchestrator } = createHarness(
      {
        defaultBranch: 'main',
        issues: [
          makeIssue({
            number: 1,
            labels: ['archon:ready', 'archon-workflow:docs', 'archon:auto-merge'],
          }),
        ],
      },
      { baseBranch: 'dev', autoMergeEnabled: true }
    );

    await orchestrator.reconcileOnce();
    const workflowRun = archon.getStartedRuns()[0];
    archon.completeRun(workflowRun.id, 'succeeded');
    github.addPullRequest(
      makePullRequest({
        number: 10,
        issueNumber: 1,
        branch: workflowRun.branch,
        baseBranch: 'dev',
        checks: 'passing',
        review: 'approved',
      })
    );

    const report = await orchestrator.reconcileOnce();
    const prs = await github.listPullRequests(repo);

    expect(report.warnings[0]).toContain('default branch (main)');
    expect(report.autoMergeCandidates).toHaveLength(0);
    expect(report.readyForHumanReview.map(pr => pr.number)).toEqual([10]);
    expect(prs[0]?.state).toBe('open');
  });

  test('blocks tracked PRs that do not contain exactly one matching closing reference', async () => {
    const { github, archon, store, orchestrator } = createHarness({
      issues: [
        makeIssue({
          number: 1,
          labels: ['archon:ready', 'archon-workflow:docs'],
        }),
      ],
    });

    await orchestrator.reconcileOnce();
    const workflowRun = archon.getStartedRuns()[0];
    archon.completeRun(workflowRun.id, 'succeeded');
    github.addPullRequest(
      makePullRequest({
        number: 10,
        issueNumber: 1,
        branch: workflowRun.branch,
        closingIssueNumbers: [1, 2],
      })
    );

    await orchestrator.reconcileOnce();
    await orchestrator.reconcileOnce();
    await orchestrator.reconcileOnce();
    const runs = await store.listRuns(repo);
    const issue = await github.getIssue(repo, 1);

    expect(runs[0]?.status).toBe('blocked');
    expect(runs[0]?.lastError).toContain('exactly one closing reference');
    expect(issue?.labels).toContain('archon:blocked');
    expect(github.getComments(1).some(comment => comment.body.includes('Fixes #1'))).toBe(true);
  });

  test('abandons stale active runs for closed issues before scheduling new work', async () => {
    const { github, archon, store, orchestrator } = createHarness(
      {
        issues: [
          makeIssue({
            number: 1,
            state: 'closed',
            labels: ['archon:in-progress', 'archon-workflow:fix-issue', 'area:test'],
          }),
          makeIssue({
            number: 2,
            labels: ['archon:ready', 'archon-workflow:tiny-self-merge', 'area:test'],
          }),
        ],
      },
      { maxParallelWorkflows: 1 }
    );

    await store.createRun({
      id: 'orchestrator-stale-closed',
      repo,
      issueNumber: 1,
      workflowRunId: 'workflow-stale-closed',
      branch: 'archon/issue-1',
      status: 'running',
      workflowLabel: 'archon-workflow:fix-issue',
      areaLabels: ['area:test'],
      changedFiles: [],
      startedAt: fixedNow,
      updatedAt: fixedNow,
      runAttempts: 1,
      fixAttempts: 0,
      commentKeys: [],
    });

    const report = await orchestrator.reconcileOnce();
    const runs = await store.listRuns(repo);
    const closedIssue = await github.getIssue(repo, 1);

    expect(runs.find(run => run.issueNumber === 1)?.status).toBe('abandoned');
    expect(runs.find(run => run.issueNumber === 1)?.lastError).toBe('Issue #1 is closed');
    expect(closedIssue?.labels).not.toContain('archon:in-progress');
    expect(report.startedRuns.map(run => run.issueNumber)).toEqual([2]);
    expect(archon.getStartedRuns().map(run => run.issueNumber)).toEqual([2]);
  });

  test('starts two issues in parallel after their shared blocker closes', async () => {
    const { github, archon, orchestrator } = createHarness(
      {
        issues: [
          makeIssue({ number: 1, labels: [] }),
          makeIssue({
            number: 2,
            labels: ['archon:ready', 'archon-workflow:tiny-self-merge', 'area:test'],
            blockedByIssueNumbers: [1],
          }),
          makeIssue({
            number: 3,
            labels: ['archon:ready', 'archon-workflow:tiny-self-merge', 'area:test'],
            blockedByIssueNumbers: [1],
          }),
        ],
      },
      {
        ...demoWorkflowConfig,
        areaLockPolicy: 'none',
        maxParallelWorkflows: 2,
        maxOpenAgentPrs: 2,
        maxNewRunsPerCycle: 2,
      }
    );

    const blockedReport = await orchestrator.reconcileOnce();
    github.closeIssue(1);
    const unblockedReport = await orchestrator.reconcileOnce();
    const secondIssue = await github.getIssue(repo, 2);
    const thirdIssue = await github.getIssue(repo, 3);

    expect(blockedReport.blockedIssues.map(blocked => blocked.issue.number)).toEqual([2, 3]);
    expect(unblockedReport.startedRuns.map(run => run.issueNumber)).toEqual([2, 3]);
    expect(secondIssue?.blockedByIssueNumbers).toEqual([]);
    expect(thirdIssue?.blockedByIssueNumbers).toEqual([]);
    expect(secondIssue?.labels).not.toContain('archon:blocked');
    expect(thirdIssue?.labels).not.toContain('archon:blocked');
    expect(archon.getStartedRuns().map(run => run.workflowName)).toEqual([
      'archon-tiny-self-merge',
      'archon-tiny-self-merge',
    ]);
  });
});
