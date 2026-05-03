import { makeIssue, makePullRequest } from '../../src/mocks';
import type { HarnessE2EFixture } from './types';

export const prValidationFailsThenFixFixture: HarnessE2EFixture = {
  name: 'pr-validation-fails-then-fix',
  cycles: 3,
  issues: [
    makeIssue({
      number: 2,
      title: 'Archon E2E validation retry',
      labels: ['archon:ready', 'archon-workflow:fix-issue', 'area:test'],
    }),
  ],
  actionsAfterCycle: {
    1: [
      {
        description: 'Complete implementation workflow and expose failing PR',
        run: ({ archon, github }): void => {
          const run = archon.getStartedRuns()[0];
          if (!run) throw new Error('Expected implementation run to be started');
          archon.completeRun(run.id, 'succeeded');
          github.addPullRequest(
            makePullRequest({
              number: 202,
              issueNumber: 2,
              branch: run.branch,
              labels: ['area:test'],
              changedFiles: ['src/retry.ts'],
              checks: 'failing',
              review: 'none',
              mergeable: true,
            })
          );
        },
      },
    ],
    2: [
      {
        description: 'Complete fix workflow and make PR pass',
        run: ({ archon, github }): void => {
          const fixRun = archon.getStartedRuns()[1];
          if (!fixRun) throw new Error('Expected fix run to be started');
          archon.completeRun(fixRun.id, 'succeeded');
          github.updatePullRequest(202, {
            checks: 'passing',
            review: 'approved',
          });
        },
      },
    ],
  },
  expectations: [
    {
      description: 'One fix attempt is scheduled before the PR becomes reviewable',
      assert: async ({ github, archon, store }): Promise<void> => {
        const issue = await github.getIssue('owner/harness', 2);
        const runs = await store.listRuns('owner/harness');
        if (archon.getStartedRuns().length !== 2) {
          throw new Error('Expected implementation run plus one fix run');
        }
        if (runs[0]?.fixAttempts !== 1) {
          throw new Error('Expected exactly one recorded fix attempt');
        }
        if (!issue?.labels.includes('archon:ready-for-review')) {
          throw new Error('Expected issue to be ready for review after fix');
        }
      },
    },
  ],
};
