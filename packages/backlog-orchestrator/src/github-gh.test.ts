import { describe, expect, test } from 'bun:test';
import { GitHubGhAdapter } from './adapters/github-gh';

describe('GitHubGhAdapter', () => {
  test('treats empty status check rollup as passing', async () => {
    const adapter = new GitHubGhAdapter();
    const mapped = (
      adapter as unknown as {
        mapPullRequest(input: {
          number: number;
          body: string;
          headRefName: string;
          baseRefName: string;
          state: string;
          isDraft: boolean;
          labels: { name: string }[];
          files: { path: string }[];
          mergeable: string;
          reviewDecision: string;
          statusCheckRollup: { state?: string; conclusion?: string; status?: string }[];
        }): { checks: string };
      }
    ).mapPullRequest({
      number: 1,
      body: 'Fixes #1',
      headRefName: 'branch',
      baseRefName: 'main',
      state: 'OPEN',
      isDraft: false,
      labels: [],
      files: [],
      mergeable: 'MERGEABLE',
      reviewDecision: '',
      statusCheckRollup: [],
    });

    expect(mapped.checks).toBe('passing');
  });
});
