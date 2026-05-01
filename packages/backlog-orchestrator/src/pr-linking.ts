export interface ClosingIssueReference {
  keyword: string;
  owner?: string;
  repo?: string;
  issueNumber: number;
}

const CLOSING_KEYWORD_PATTERN = String.raw`(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)`;
const ISSUE_REFERENCE_PATTERN = new RegExp(
  String.raw`\b(${CLOSING_KEYWORD_PATTERN})\:?\s+(?:(([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+))#|#)(\d+)\b`,
  'gi'
);

export function extractClosingIssueReferences(body: string): ClosingIssueReference[] {
  const references: ClosingIssueReference[] = [];
  for (const match of body.matchAll(ISSUE_REFERENCE_PATTERN)) {
    const keyword = match[1]?.toLowerCase();
    const owner = match[3];
    const repo = match[4];
    const rawIssueNumber = match[5];
    if (!keyword || !rawIssueNumber) continue;
    const issueNumber = Number(rawIssueNumber);
    if (!Number.isInteger(issueNumber)) continue;
    references.push({ keyword, owner, repo, issueNumber });
  }
  return references;
}

export function findSingleClosingIssueNumber(body: string): number | undefined {
  const references = extractClosingIssueReferences(body);
  return references.length === 1 ? references[0]?.issueNumber : undefined;
}

export function isClosingReferenceForIssue(body: string, issueNumber: number): boolean {
  const references = extractClosingIssueReferences(body);
  return references.length === 1 && references[0]?.issueNumber === issueNumber;
}
