import type {
  ArchonPort,
  GitHubPort,
  HarnessIssue,
  HarnessPullRequest,
  HarnessWorkflowRun,
  OrchestratorStore,
  StartWorkflowInput,
  StoredOrchestratorRun,
  WorkflowRunState,
} from './types';

export interface IssueComment {
  issueNumber: number;
  body: string;
}

export class InMemoryGitHub implements GitHubPort {
  private readonly issues = new Map<number, HarnessIssue>();
  private readonly pullRequests = new Map<number, HarnessPullRequest>();
  private readonly comments: IssueComment[] = [];
  private readonly defaultBranch: string;
  private readonly autoCloseIssuesEnabled: boolean;

  constructor(
    input: {
      issues?: HarnessIssue[];
      pullRequests?: HarnessPullRequest[];
      defaultBranch?: string;
      autoCloseIssuesEnabled?: boolean;
    } = {}
  ) {
    this.defaultBranch = input.defaultBranch ?? 'main';
    this.autoCloseIssuesEnabled = input.autoCloseIssuesEnabled ?? true;
    for (const issue of input.issues ?? []) {
      this.issues.set(issue.number, cloneIssue(issue));
    }
    for (const pr of input.pullRequests ?? []) {
      this.pullRequests.set(pr.number, clonePullRequest(pr));
    }
  }

  async getRepositoryInfo(
    _repo: string
  ): Promise<{ defaultBranch: string; autoCloseIssuesEnabled: boolean }> {
    return {
      defaultBranch: this.defaultBranch,
      autoCloseIssuesEnabled: this.autoCloseIssuesEnabled,
    };
  }

  async listIssues(_repo: string): Promise<HarnessIssue[]> {
    return [...this.issues.values()]
      .map(cloneIssue)
      .sort((left, right) => left.number - right.number);
  }

  async getIssue(_repo: string, issueNumber: number): Promise<HarnessIssue | undefined> {
    const issue = this.issues.get(issueNumber);
    return issue ? cloneIssue(issue) : undefined;
  }

  async listPullRequests(_repo: string): Promise<HarnessPullRequest[]> {
    return [...this.pullRequests.values()]
      .map(clonePullRequest)
      .sort((left, right) => left.number - right.number);
  }

  async findPullRequestByBranch(
    _repo: string,
    branch: string
  ): Promise<HarnessPullRequest | undefined> {
    const pr = [...this.pullRequests.values()].find(candidate => candidate.branch === branch);
    return pr ? clonePullRequest(pr) : undefined;
  }

  async addIssueLabel(_repo: string, issueNumber: number, label: string): Promise<void> {
    const issue = this.requireIssue(issueNumber);
    if (!issue.labels.includes(label)) issue.labels.push(label);
  }

  async removeIssueLabel(_repo: string, issueNumber: number, label: string): Promise<void> {
    const issue = this.requireIssue(issueNumber);
    issue.labels = issue.labels.filter(candidate => candidate !== label);
  }

  async removeIssueBlockedBy(
    _repo: string,
    issueNumber: number,
    blockingIssueNumber: number
  ): Promise<void> {
    const issue = this.requireIssue(issueNumber);
    issue.blockedByIssueNumbers = issue.blockedByIssueNumbers.filter(
      candidate => candidate !== blockingIssueNumber
    );
  }

  async addIssueComment(_repo: string, issueNumber: number, body: string): Promise<void> {
    this.requireIssue(issueNumber);
    if (this.comments.some(comment => comment.issueNumber === issueNumber && comment.body === body))
      return;
    this.comments.push({ issueNumber, body });
  }

  async mergePullRequest(_repo: string, prNumber: number): Promise<void> {
    const pr = this.requirePullRequest(prNumber);
    pr.state = 'merged';
  }

  addPullRequest(pr: HarnessPullRequest): void {
    this.pullRequests.set(pr.number, clonePullRequest(pr));
  }

  updatePullRequest(prNumber: number, updates: Partial<HarnessPullRequest>): void {
    const pr = this.requirePullRequest(prNumber);
    this.pullRequests.set(prNumber, { ...pr, ...updates });
  }

  closeIssue(issueNumber: number): void {
    this.requireIssue(issueNumber).state = 'closed';
  }

  getComments(issueNumber?: number): IssueComment[] {
    return this.comments.filter(
      comment => issueNumber === undefined || comment.issueNumber === issueNumber
    );
  }

  private requireIssue(issueNumber: number): HarnessIssue {
    const issue = this.issues.get(issueNumber);
    if (!issue) throw new Error(`Unknown issue #${issueNumber}`);
    return issue;
  }

  private requirePullRequest(prNumber: number): HarnessPullRequest {
    const pr = this.pullRequests.get(prNumber);
    if (!pr) throw new Error(`Unknown PR #${prNumber}`);
    return pr;
  }
}

export class InMemoryArchon implements ArchonPort {
  private readonly runs = new Map<string, HarnessWorkflowRun>();
  private nextRunNumber = 1;

  async startWorkflow(input: StartWorkflowInput): Promise<HarnessWorkflowRun> {
    const id = `workflow-${this.nextRunNumber}`;
    this.nextRunNumber += 1;

    const run: HarnessWorkflowRun = {
      id,
      workflowName: input.workflowName,
      issueNumber: input.issue.number,
      branch: input.branch ?? `archon/issue-${input.issue.number}`,
      state: 'running',
    };
    this.runs.set(id, run);
    return { ...run };
  }

  async getWorkflowRun(runId: string): Promise<HarnessWorkflowRun | undefined> {
    const run = this.runs.get(runId);
    return run ? { ...run } : undefined;
  }

  completeRun(runId: string, state: Exclude<WorkflowRunState, 'running'>, error?: string): void {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Unknown workflow run ${runId}`);
    this.runs.set(runId, { ...run, state, error });
  }

  getStartedRuns(): HarnessWorkflowRun[] {
    return [...this.runs.values()].map(run => ({ ...run }));
  }
}

export class InMemoryOrchestratorStore implements OrchestratorStore {
  private readonly runs = new Map<string, StoredOrchestratorRun>();

  async listRuns(repo: string): Promise<StoredOrchestratorRun[]> {
    return [...this.runs.values()]
      .filter(run => run.repo === repo)
      .map(cloneStoredRun)
      .sort((left, right) => left.startedAt.getTime() - right.startedAt.getTime());
  }

  async createRun(run: StoredOrchestratorRun): Promise<void> {
    if (this.runs.has(run.id)) throw new Error(`Run ${run.id} already exists`);
    this.runs.set(run.id, cloneStoredRun(run));
  }

  async updateRun(run: StoredOrchestratorRun): Promise<void> {
    const existing = this.runs.get(run.id);
    if (!existing) throw new Error(`Unknown orchestrator run ${run.id}`);
    this.runs.set(run.id, cloneStoredRun({ ...existing, ...run }));
  }
}

export function makeIssue(
  overrides: Partial<HarnessIssue> & Pick<HarnessIssue, 'number'>
): HarnessIssue {
  return {
    title: `Issue ${overrides.number}`,
    body: '## Goal\n\nTest issue',
    state: 'open',
    labels: [],
    blockedByIssueNumbers: [],
    ...overrides,
  };
}

export function makePullRequest(
  overrides: Partial<HarnessPullRequest> &
    Pick<HarnessPullRequest, 'number' | 'issueNumber' | 'branch'>
): HarnessPullRequest {
  return {
    state: 'open',
    draft: false,
    labels: [],
    changedFiles: [],
    checks: 'pending',
    review: 'none',
    mergeable: true,
    mergeability: 'mergeable',
    baseBranch: 'main',
    closingIssueNumbers: [overrides.issueNumber],
    ...overrides,
  };
}

function cloneIssue(issue: HarnessIssue): HarnessIssue {
  return {
    ...issue,
    labels: [...issue.labels],
    blockedByIssueNumbers: [...issue.blockedByIssueNumbers],
  };
}

function clonePullRequest(pr: HarnessPullRequest): HarnessPullRequest {
  return {
    ...pr,
    labels: [...pr.labels],
    changedFiles: [...pr.changedFiles],
  };
}

function cloneStoredRun(run: StoredOrchestratorRun): StoredOrchestratorRun {
  return {
    ...run,
    areaLabels: [...run.areaLabels],
    changedFiles: [...run.changedFiles],
    startedAt: new Date(run.startedAt),
    updatedAt: new Date(run.updatedAt),
    commentKeys: [...run.commentKeys],
  };
}
