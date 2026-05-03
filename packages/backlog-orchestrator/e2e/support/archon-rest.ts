import type {
  ArchonPort,
  HarnessIssue,
  HarnessWorkflowRun,
  StartWorkflowInput,
  WorkflowRunState,
} from '../../src/types';

interface ArchonRestOptions {
  baseUrl: string;
  codebaseUrl: string;
  codebaseCwd?: string;
  sessionId: string;
  branchName?: string;
  token?: string;
  pollTimeoutMs?: number;
  pollIntervalMs?: number;
}

interface CodebaseResponse {
  id: string;
  repository_url: string | null;
  default_cwd: string;
}

interface ConversationResponse {
  conversationId: string;
  id: string;
}

interface WorkflowRunResponse {
  id: string;
  workflow_name: string;
  conversation_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'paused';
  user_message: string;
  metadata: Record<string, unknown>;
  started_at?: string;
}

interface WorkflowRunListResponse {
  runs: WorkflowRunResponse[];
}

interface WorkflowRunDetailResponse {
  run: WorkflowRunResponse;
  events: { event_type: string; data: Record<string, unknown> }[];
}

interface StartedRunMetadata {
  branch: string;
  issueNumber: number;
  workflowName: string;
}

export class ArchonRestAdapter implements ArchonPort {
  private readonly baseUrl: string;
  private readonly codebaseUrl: string;
  private readonly codebaseCwd?: string;
  private readonly sessionId: string;
  private readonly branchName?: string;
  private readonly token?: string;
  private readonly pollTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly startedRuns = new Map<string, StartedRunMetadata>();
  private codebaseId: string | undefined;

  constructor(options: ArchonRestOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.codebaseUrl = options.codebaseUrl;
    this.codebaseCwd = options.codebaseCwd;
    this.sessionId = options.sessionId;
    this.branchName = options.branchName;
    this.token = options.token;
    this.pollTimeoutMs = options.pollTimeoutMs ?? 30_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
  }

  async checkHealth(): Promise<void> {
    await this.request<unknown>('/api/health', { method: 'GET' });
  }

  async startWorkflow(input: StartWorkflowInput): Promise<HarnessWorkflowRun> {
    const codebaseId = await this.ensureCodebase();
    const conversation = await this.createConversation(codebaseId);
    const branch = input.branch ?? this.branchForIssue(input.issue);
    const message = buildWorkflowPrompt(input, branch, this.sessionId);
    const requestedAt = new Date();

    await this.request(`/api/workflows/${encodeURIComponent(input.workflowName)}/run`, {
      method: 'POST',
      body: JSON.stringify({ conversationId: conversation.conversationId, message }),
    });

    const run = await this.waitForWorkflowRun({
      conversationDbId: conversation.id,
      workflowName: input.workflowName,
      issue: input.issue,
      requestedAt,
    });
    this.startedRuns.set(run.id, {
      branch,
      issueNumber: input.issue.number,
      workflowName: input.workflowName,
    });

    return {
      id: run.id,
      workflowName: run.workflow_name,
      issueNumber: input.issue.number,
      branch,
      state: mapWorkflowRunState(run.status),
    };
  }

  async getWorkflowRun(runId: string): Promise<HarnessWorkflowRun | undefined> {
    const metadata = this.startedRuns.get(runId);
    const response = await this.request<WorkflowRunDetailResponse>(
      `/api/workflows/runs/${encodeURIComponent(runId)}`,
      { method: 'GET' },
      { allowNotFound: true }
    );
    if (!response) return undefined;
    const error = extractError(response);
    return {
      id: response.run.id,
      workflowName: response.run.workflow_name,
      issueNumber: metadata?.issueNumber ?? extractIssueNumber(response.run.user_message),
      branch: metadata?.branch ?? extractBranch(response.run.user_message) ?? 'unknown',
      state: mapWorkflowRunState(response.run.status),
      error,
    };
  }

  private async ensureCodebase(): Promise<string> {
    if (this.codebaseId) return this.codebaseId;
    const codebases = await this.request<CodebaseResponse[]>('/api/codebases', { method: 'GET' });
    const normalizedTarget = normalizeRepoUrl(this.codebaseUrl);
    const existing = codebases.find(
      codebase =>
        normalizeRepoUrl(codebase.repository_url ?? '') === normalizedTarget ||
        (this.codebaseCwd !== undefined && codebase.default_cwd === this.codebaseCwd)
    );
    if (existing) {
      this.codebaseId = existing.id;
      return existing.id;
    }

    const created = await this.request<CodebaseResponse>('/api/codebases', {
      method: 'POST',
      body: JSON.stringify({ url: this.codebaseUrl }),
    });
    this.codebaseId = created.id;
    return created.id;
  }

  private async createConversation(codebaseId: string): Promise<ConversationResponse> {
    return this.request<ConversationResponse>('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({ codebaseId }),
    });
  }

  private async waitForWorkflowRun(input: {
    conversationDbId: string;
    workflowName: string;
    issue: HarnessIssue;
    requestedAt: Date;
  }): Promise<WorkflowRunResponse> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < this.pollTimeoutMs) {
      const run = await this.findStartedWorkflowRun(input);
      if (run) return run;
      await sleep(this.pollIntervalMs);
    }
    throw new Error(
      `Timed out waiting for Archon workflow run ${input.workflowName} for issue #${String(
        input.issue.number
      )}`
    );
  }

  private async findStartedWorkflowRun(input: {
    conversationDbId: string;
    workflowName: string;
    issue: HarnessIssue;
    requestedAt: Date;
  }): Promise<WorkflowRunResponse | undefined> {
    const scopedResponse = await this.request<WorkflowRunListResponse>(
      `/api/workflows/runs?conversationId=${encodeURIComponent(input.conversationDbId)}&limit=10`,
      { method: 'GET' }
    );
    const scopedRun = scopedResponse.runs.find(candidate => this.isMatchingRun(candidate, input));
    if (scopedRun) return scopedRun;

    const recentResponse = await this.request<WorkflowRunListResponse>(
      '/api/workflows/runs?limit=20',
      { method: 'GET' }
    );
    return recentResponse.runs.find(
      candidate => this.isMatchingRun(candidate, input) && isFreshRun(candidate, input.requestedAt)
    );
  }

  private isMatchingRun(
    candidate: WorkflowRunResponse,
    input: { workflowName: string; issue: HarnessIssue }
  ): boolean {
    return (
      candidate.workflow_name === input.workflowName &&
      candidate.user_message.includes(`[archon-test:${this.sessionId}]`) &&
      candidate.user_message.includes(`#${String(input.issue.number)}`)
    );
  }

  private branchForIssue(issue: HarnessIssue): string {
    if (this.branchName) return this.branchName;
    return `archon-test/issue-${String(issue.number)}-${this.sessionId}`;
  }

  private async request<T>(
    path: string,
    init: RequestInit,
    options?: { allowNotFound?: false }
  ): Promise<T>;
  private async request<T>(
    path: string,
    init: RequestInit,
    options: { allowNotFound: true }
  ): Promise<T | undefined>;
  private async request<T>(
    path: string,
    init: RequestInit,
    options: { allowNotFound?: boolean } = {}
  ): Promise<T | undefined> {
    const headers = new Headers(init.headers);
    headers.set('Content-Type', 'application/json');
    if (this.token) headers.set('Authorization', `Bearer ${this.token}`);

    const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
    if (response.status === 404 && options.allowNotFound === true) return undefined;
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Archon API ${init.method ?? 'GET'} ${path} failed: ${response.status} ${body}`
      );
    }
    return (await response.json()) as T;
  }
}

function buildWorkflowPrompt(input: StartWorkflowInput, branch: string, sessionId: string): string {
  const prLine = input.prNumber ? `PR: #${String(input.prNumber)}\n` : '';
  if (input.mode === 'conflict') {
    return [
      `[archon-test:${sessionId}]`,
      `Resolve merge conflicts for PR #${String(input.prNumber)}.`,
      `Repository: ${input.repo}`,
      `Issue: #${String(input.issue.number)} ${input.issue.title}`,
      prLine.trimEnd(),
      `Mode: ${input.mode}`,
      `Use branch: ${branch}`,
      '',
      input.issue.body,
    ]
      .filter(line => line.length > 0)
      .join('\n');
  }

  return [
    `[archon-test:${sessionId}]`,
    `Repository: ${input.repo}`,
    `Issue: #${String(input.issue.number)} ${input.issue.title}`,
    prLine.trimEnd(),
    `Mode: ${input.mode}`,
    `Use branch: ${branch}`,
    '',
    input.issue.body,
  ]
    .filter(line => line.length > 0)
    .join('\n');
}

function mapWorkflowRunState(status: WorkflowRunResponse['status']): WorkflowRunState {
  if (status === 'completed') return 'succeeded';
  if (status === 'failed') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  return 'running';
}

function extractIssueNumber(message: string): number {
  const match = /Issue:\s+#(\d+)/.exec(message);
  return match ? Number(match[1]) : 0;
}

function extractBranch(message: string): string | undefined {
  return /Use branch:\s+(\S+)/.exec(message)?.[1];
}

function isFreshRun(run: WorkflowRunResponse, requestedAt: Date): boolean {
  if (!run.started_at) return false;
  const startedAt = Date.parse(run.started_at);
  if (Number.isNaN(startedAt)) return false;
  return startedAt >= requestedAt.getTime() - 5_000;
}

function extractError(response: WorkflowRunDetailResponse): string | undefined {
  if (response.run.status !== 'failed' && response.run.status !== 'cancelled') return undefined;
  const failedEvent = response.events.find(event => event.event_type.includes('failed'));
  const eventError = failedEvent?.data.error;
  if (typeof eventError === 'string') return eventError;
  return `Workflow ${response.run.status}`;
}

function normalizeRepoUrl(url: string): string {
  return url.replace(/\.git$/, '').replace(/^git@github\.com:/, 'https://github.com/');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
