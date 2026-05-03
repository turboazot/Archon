import { makeIssue, makePullRequest } from '../../src/mocks';
import type { HarnessE2EFixture } from './types';

export const readySuccessFixture: HarnessE2EFixture = {
  name: 'ready-success',
  cycles: 2,
  issues: [
    makeIssue({
      number: 1,
      title: 'Archon E2E ready success',
      labels: ['archon:ready', 'archon-workflow:fix-issue', 'area:test'],
    }),
  ],
  actionsAfterCycle: {
    1: [
      {
        description: 'Complete implementation workflow and expose passing PR',
        run: ({ archon, github }): void => {
          const run = archon.getStartedRuns()[0];
          if (!run) throw new Error('Expected implementation run to be started');
          archon.completeRun(run.id, 'succeeded');
          github.addPullRequest(
            makePullRequest({
              number: 101,
              issueNumber: 1,
              branch: run.branch,
              labels: ['area:test'],
              changedFiles: ['src/example.ts'],
              checks: 'passing',
              review: 'approved',
              mergeable: true,
            })
          );
        },
      },
    ],
  },
  expectations: [
    {
      description: 'Issue reaches ready-for-review with a tracked PR',
      assert: async ({ github, store }): Promise<void> => {
        const issue = await github.getIssue('owner/harness', 1);
        const runs = await store.listRuns('owner/harness');
        if (!issue?.labels.includes('archon:ready-for-review')) {
          throw new Error('Expected issue to be ready for review');
        }
        if (runs[0]?.prNumber !== 101) {
          throw new Error('Expected run to track PR #101');
        }
      },
    },
  ],
};
