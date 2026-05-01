import { describe, expect, test } from 'bun:test';
import {
  extractClosingIssueReferences,
  findSingleClosingIssueNumber,
  isClosingReferenceForIssue,
} from './pr-linking';

describe('PR issue closing references', () => {
  test('parses same-repository closing keywords', () => {
    expect(findSingleClosingIssueNumber('Implements the fix.\n\nFixes #123')).toBe(123);
    expect(findSingleClosingIssueNumber('Closes: #42')).toBe(42);
    expect(findSingleClosingIssueNumber('RESOLVES #7')).toBe(7);
  });

  test('parses cross-repository closing references', () => {
    expect(extractClosingIssueReferences('Fixes octo-org/octo-repo#100')).toEqual([
      {
        keyword: 'fixes',
        owner: 'octo-org',
        repo: 'octo-repo',
        issueNumber: 100,
      },
    ]);
  });

  test('rejects multiple closing references for single-issue mapping', () => {
    expect(findSingleClosingIssueNumber('Fixes #1 and resolves #2')).toBeUndefined();
    expect(isClosingReferenceForIssue('Fixes #1 and resolves #2', 1)).toBe(false);
  });

  test('ignores non-closing issue references', () => {
    expect(findSingleClosingIssueNumber('Related to #55 and refs #56')).toBeUndefined();
    expect(extractClosingIssueReferences('Related to #55')).toEqual([]);
  });
});
