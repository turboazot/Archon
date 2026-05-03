import { LIFECYCLE_LABELS, TERMINAL_RUN_STATUSES, WORKFLOW_LABEL_PREFIX } from './lifecycle';
import type {
  AreaLockPolicy,
  HarnessIssue,
  HarnessPullRequest,
  StoredOrchestratorRun,
} from './types';

export interface EligibilityResult {
  issue: HarnessIssue;
  workflowLabel?: string;
  blockedReason?: string;
  shouldMarkBlocked?: boolean;
}

export interface EligibilityInput {
  issues: HarnessIssue[];
  runs: StoredOrchestratorRun[];
  activeRuns: StoredOrchestratorRun[];
  openAgentPrs: HarnessPullRequest[];
  areaLockPolicy: AreaLockPolicy;
}

export function evaluateIssuesForScheduling(input: EligibilityInput): EligibilityResult[] {
  return input.issues
    .filter(issue => issue.state === 'open')
    .filter(issue => issue.labels.includes(LIFECYCLE_LABELS.ready))
    .map(issue => evaluateIssue(issue, input));
}

export function findAreaLabels(labels: string[]): string[] {
  return labels.filter(label => label.startsWith('area:'));
}

function evaluateIssue(issue: HarnessIssue, input: EligibilityInput): EligibilityResult {
  const workflowLabels = issue.labels.filter(label => label.startsWith(WORKFLOW_LABEL_PREFIX));
  const ownsIssue = input.runs.some(
    run => run.issueNumber === issue.number && !TERMINAL_RUN_STATUSES.has(run.status)
  );

  if (ownsIssue) return { issue };
  if (workflowLabels.length === 0) {
    return {
      issue,
      blockedReason: 'Missing archon-workflow:* routing label',
      shouldMarkBlocked: true,
    };
  }
  if (workflowLabels.length > 1) {
    return { issue, blockedReason: 'Ambiguous workflow routing labels', shouldMarkBlocked: true };
  }

  const openBlockers = issue.blockedByIssueNumbers.filter(blockerNumber =>
    input.issues.some(candidate => candidate.number === blockerNumber && candidate.state === 'open')
  );
  if (openBlockers.length > 0) {
    return {
      issue,
      blockedReason: `Blocked by open issue(s): ${openBlockers.join(', ')}`,
      shouldMarkBlocked: false,
    };
  }

  if (hasAreaConflict(issue, input.activeRuns, input.openAgentPrs, input.areaLockPolicy)) {
    return { issue, blockedReason: 'Blocked by area lock conflict', shouldMarkBlocked: true };
  }

  return { issue, workflowLabel: workflowLabels[0] };
}

function hasAreaConflict(
  issue: HarnessIssue,
  activeRuns: StoredOrchestratorRun[],
  openAgentPrs: HarnessPullRequest[],
  areaLockPolicy: AreaLockPolicy
): boolean {
  if (areaLockPolicy === 'none') return false;

  const issueAreas = findAreaLabels(issue.labels);
  if (issueAreas.length === 0) return activeRuns.length > 0 || openAgentPrs.length > 0;

  const activeAreas = new Set([
    ...activeRuns.flatMap(run => run.areaLabels),
    ...openAgentPrs.flatMap(pr => findAreaLabels(pr.labels)),
  ]);
  return issueAreas.some(label => activeAreas.has(label));
}
