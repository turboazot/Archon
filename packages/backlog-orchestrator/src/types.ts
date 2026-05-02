export type AreaLockPolicy = 'none' | 'conservative';

export type WorkflowRunState = 'running' | 'succeeded' | 'failed' | 'cancelled';

export type PullRequestState = 'open' | 'closed' | 'merged';

export type CheckState = 'pending' | 'passing' | 'failing';

export type ReviewState = 'none' | 'approved' | 'changes_requested';

export type MergeabilityState = 'mergeable' | 'conflicting' | 'unknown';

export type OrchestratorRunStatus =
  | 'queued'
  | 'running'
  | 'pr_open'
  | 'ready_for_review'
  | 'needs_fix'
  | 'fix_running'
  | 'conflict_running'
  | 'blocked'
  | 'done'
  | 'failed'
  | 'abandoned';

export interface HarnessIssue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  blockedByIssueNumbers: number[];
}

export interface HarnessPullRequest {
  number: number;
  issueNumber: number;
  branch: string;
  baseBranch: string;
  state: PullRequestState;
  draft: boolean;
  labels: string[];
  changedFiles: string[];
  checks: CheckState;
  review: ReviewState;
  mergeable: boolean;
  mergeability: MergeabilityState;
  closingIssueNumbers: number[];
}

export interface HarnessWorkflowRun {
  id: string;
  workflowName: string;
  issueNumber: number;
  branch: string;
  state: WorkflowRunState;
  error?: string;
}

export interface StoredOrchestratorRun {
  id: string;
  repo: string;
  issueNumber: number;
  workflowRunId: string;
  branch: string;
  prNumber?: number;
  status: OrchestratorRunStatus;
  workflowLabel: string;
  areaLabels: string[];
  changedFiles: string[];
  startedAt: Date;
  updatedAt: Date;
  lastError?: string;
  runAttempts: number;
  fixAttempts: number;
  commentKeys: string[];
}

export interface GitHubPort {
  getRepositoryInfo(repo: string): Promise<RepositoryInfo>;
  listIssues(repo: string): Promise<HarnessIssue[]>;
  getIssue(repo: string, issueNumber: number): Promise<HarnessIssue | undefined>;
  listPullRequests(repo: string): Promise<HarnessPullRequest[]>;
  findPullRequestByBranch(repo: string, branch: string): Promise<HarnessPullRequest | undefined>;
  addIssueLabel(repo: string, issueNumber: number, label: string): Promise<void>;
  removeIssueLabel(repo: string, issueNumber: number, label: string): Promise<void>;
  removeIssueBlockedBy(
    repo: string,
    issueNumber: number,
    blockingIssueNumber: number
  ): Promise<void>;
  addIssueComment(repo: string, issueNumber: number, body: string): Promise<void>;
  mergePullRequest(repo: string, prNumber: number): Promise<void>;
}

export interface RepositoryInfo {
  defaultBranch: string;
  autoCloseIssuesEnabled?: boolean;
}

export interface ArchonPort {
  startWorkflow(input: StartWorkflowInput): Promise<HarnessWorkflowRun>;
  getWorkflowRun(runId: string): Promise<HarnessWorkflowRun | undefined>;
}

export interface OrchestratorStore {
  listRuns(repo: string): Promise<StoredOrchestratorRun[]>;
  createRun(run: StoredOrchestratorRun): Promise<void>;
  updateRun(run: StoredOrchestratorRun): Promise<void>;
}

export interface StartWorkflowInput {
  repo: string;
  issue: HarnessIssue;
  workflowName: string;
  branch?: string;
  prNumber?: number;
  mode: 'implement' | 'fix' | 'conflict';
}

export interface HarnessOrchestratorConfig {
  repo: string;
  baseBranch?: string;
  maxParallelWorkflows: number;
  maxOpenAgentPrs: number;
  maxNewRunsPerCycle: number;
  autoMergeEnabled: boolean;
  maxRunAttempts: number;
  maxFixAttempts: number;
  conflictWorkflowName: string;
  areaLockPolicy: AreaLockPolicy;
  workflowLabelToName: Record<string, string>;
  workflowLabelsCompletingWithoutPr: string[];
  now: () => Date;
}

export type BacklogOrchestratorConfig = HarnessOrchestratorConfig;

export interface HarnessOrchestratorPorts {
  github: GitHubPort;
  archon: ArchonPort;
  store: OrchestratorStore;
}

export interface StatusReport {
  activeRuns: StoredOrchestratorRun[];
  openAgentPrs: HarnessPullRequest[];
  readyForHumanReview: HarnessPullRequest[];
  autoMergeCandidates: HarnessPullRequest[];
  waitingForCapacity: HarnessIssue[];
  blockedIssues: BlockedIssue[];
  nextEligibleIssues: HarnessIssue[];
  failedRuns: StoredOrchestratorRun[];
  startedRuns: StoredOrchestratorRun[];
  warnings: string[];
}

export interface BlockedIssue {
  issue: HarnessIssue;
  reason: string;
}
