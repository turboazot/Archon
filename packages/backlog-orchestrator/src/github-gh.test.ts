import { describe, expect, test } from 'bun:test';
import { mapCheckState } from './adapters/github-gh';

describe('GitHubGhAdapter', () => {
  test('treats empty status check rollup as pending', () => {
    expect(mapCheckState([])).toBe('pending');
  });

  test('maps successful status checks as passing', () => {
    expect(mapCheckState([{ conclusion: 'SUCCESS' }])).toBe('passing');
  });
});
