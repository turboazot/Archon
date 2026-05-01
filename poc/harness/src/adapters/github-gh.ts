import { execFile } from 'child_process';
import { promisify } from 'util';
import type {
  CheckState,
  GitHubPort,
  HarnessIssue,
  HarnessPullRequest,
  ReviewState,
  MergeabilityState,
} from '../types';

const execFileAsync = promisify(execFile);

interface GitHubGhOptions {
  allowMerge?: boolean;
}

interface GhLabel {
  name: string;
}

interface GhIssue {
  id?: number;
  number: number;
  title: string;
  body: string;
  state: string;
  labels: GhLabel[];
}

interface GhPullRequest {
  number: number;
  body: string;
  headRefName: string;
  state: string;
  isDraft: boolean;
  labels: GhLabel[];
  files: { path: string }[];
  mergeable: string;
  reviewDecision: string;
  statusCheckRollup: { state?: string; conclusion?: string; status?: string }[];
}

export class GitHubGhAdapter implements GitHubPort {
  private readonly allowMerge: boolean;

  constructor(options: GitHubGhOptions = {}) {
    this.allowMerge = options.allowMerge ?? false;
  }

  async listIssues(repo: string): Promise<HarnessIssue[]> {
    const issues = await ghJson<GhIssue[]>([
      'issue',
      'list',
      '--repo',
      repo,
      '--state',
      'open',
      '--limit',
      '100',
      '--json',
      'number,title,body,state,labels',
    ]);
    const mapped = await Promise.all(
      issues.map(async issue => this.mapIssueWithDependencies(repo, issue))
    );
    return mapped.sort((left, right) => left.number - right.number);
  }

  async getIssue(repo: string, issueNumber: number): Promise<HarnessIssue | undefined> {
    try {
      const issue = await ghJson<GhIssue>([
        'issue',
        'view',
        String(issueNumber),
        '--repo',
        repo,
        '--json',
        'number,title,body,state,labels',
      ]);
      return await this.mapIssueWithDependencies(repo, issue);
    } catch (error) {
      if (isGhNotFound(error)) return undefined;
      throw error;
    }
  }

  async listPullRequests(repo: string): Promise<HarnessPullRequest[]> {
    const prs = await ghJson<GhPullRequest[]>([
      'pr',
      'list',
      '--repo',
      repo,
      '--state',
      'all',
      '--limit',
      '100',
      '--json',
      'number,body,headRefName,state,isDraft,labels,files,mergeable,reviewDecision,statusCheckRollup',
    ]);
    return prs.map(mapPullRequest).sort((left, right) => left.number - right.number);
  }

  async findPullRequestByBranch(
    repo: string,
    branch: string
  ): Promise<HarnessPullRequest | undefined> {
    const prs = await this.listPullRequests(repo);
    return prs.find(pr => pr.branch === branch);
  }

  async addIssueLabel(repo: string, issueNumber: number, label: string): Promise<void> {
    await gh(['issue', 'edit', String(issueNumber), '--repo', repo, '--add-label', label]);
  }

  async removeIssueLabel(repo: string, issueNumber: number, label: string): Promise<void> {
    try {
      await gh(['issue', 'edit', String(issueNumber), '--repo', repo, '--remove-label', label]);
    } catch (error) {
      if (!String(error).includes('not found')) throw error;
    }
  }

  async addIssueComment(repo: string, issueNumber: number, body: string): Promise<void> {
    await gh(['issue', 'comment', String(issueNumber), '--repo', repo, '--body', body]);
  }

  async mergePullRequest(repo: string, prNumber: number): Promise<void> {
    if (!this.allowMerge) {
      throw new Error('Live GitHub merge is disabled. Set ARCHON_E2E_ALLOW_MERGE=1 to allow it.');
    }
    await gh(['pr', 'merge', String(prNumber), '--repo', repo, '--squash']);
  }

  async addIssueBlockedBy(
    repo: string,
    issueNumber: number,
    blockingIssueNumber: number
  ): Promise<void> {
    const blockingIssue = await ghJson<GhIssue>([
      'api',
      '-H',
      'Accept: application/vnd.github+json',
      '-H',
      'X-GitHub-Api-Version: 2026-03-10',
      `repos/${repo}/issues/${String(blockingIssueNumber)}`,
    ]);
    if (!blockingIssue.id) {
      throw new Error(`Could not read REST issue id for #${String(blockingIssueNumber)}`);
    }
    await gh([
      'api',
      '--method',
      'POST',
      '-H',
      'Accept: application/vnd.github+json',
      '-H',
      'X-GitHub-Api-Version: 2026-03-10',
      `repos/${repo}/issues/${String(issueNumber)}/dependencies/blocked_by`,
      '-F',
      `issue_id=${String(blockingIssue.id)}`,
    ]);
  }

  async removeIssueBlockedBy(
    repo: string,
    issueNumber: number,
    blockingIssueNumber: number
  ): Promise<void> {
    const blockingIssue = await ghJson<GhIssue>([
      'api',
      '-H',
      'Accept: application/vnd.github+json',
      '-H',
      'X-GitHub-Api-Version: 2026-03-10',
      `repos/${repo}/issues/${String(blockingIssueNumber)}`,
    ]);
    if (!blockingIssue.id) {
      throw new Error(`Could not read REST issue id for #${String(blockingIssueNumber)}`);
    }

    try {
      await gh([
        'api',
        '--method',
        'DELETE',
        '-H',
        'Accept: application/vnd.github+json',
        '-H',
        'X-GitHub-Api-Version: 2026-03-10',
        `repos/${repo}/issues/${String(issueNumber)}/dependencies/blocked_by/${String(
          blockingIssue.id
        )}`,
      ]);
    } catch (error) {
      const message = String(error);
      if (!message.includes('404') && !message.includes('Not Found')) throw error;
    }
  }

  async ensureLabel(repo: string, name: string, color = '5319e7'): Promise<void> {
    const labels = await ghJson<GhLabel[]>([
      'label',
      'list',
      '--repo',
      repo,
      '--limit',
      '1000',
      '--json',
      'name',
    ]);
    if (labels.some(label => label.name === name)) return;
    await gh([
      'label',
      'create',
      name,
      '--repo',
      repo,
      '--color',
      color,
      '--description',
      'Archon E2E harness label',
    ]);
  }

  async createIssue(input: {
    repo: string;
    title: string;
    body: string;
    labels: string[];
  }): Promise<HarnessIssue> {
    const issueUrl = (
      await gh([
        'issue',
        'create',
        '--repo',
        input.repo,
        '--title',
        input.title,
        '--body',
        input.body,
        ...input.labels.flatMap(label => ['--label', label]),
      ])
    ).trim();
    const issueNumber = Number(issueUrl.split('/').at(-1));
    if (!Number.isInteger(issueNumber)) {
      throw new Error(`Could not parse issue number from gh output: ${issueUrl}`);
    }
    const issue = await this.getIssue(input.repo, issueNumber);
    if (!issue) throw new Error(`Created issue #${String(issueNumber)} but could not read it`);
    return issue;
  }

  private async mapIssueWithDependencies(repo: string, issue: GhIssue): Promise<HarnessIssue> {
    const blockedByIssueNumbers = await this.listBlockedByIssueNumbers(repo, issue.number);
    return mapIssue(issue, blockedByIssueNumbers);
  }

  private async listBlockedByIssueNumbers(repo: string, issueNumber: number): Promise<number[]> {
    const dependencies = await ghJson<GhIssue[]>([
      'api',
      '-H',
      'Accept: application/vnd.github+json',
      '-H',
      'X-GitHub-Api-Version: 2026-03-10',
      `repos/${repo}/issues/${String(issueNumber)}/dependencies/blocked_by`,
    ]);
    return dependencies.map(issue => issue.number).filter(Number.isInteger);
  }
}

async function gh(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('gh', args, { timeout: 30_000 });
  return stdout;
}

async function ghJson<T>(args: string[]): Promise<T> {
  const stdout = await gh(args);
  return JSON.parse(stdout) as T;
}

function mapIssue(issue: GhIssue, blockedByIssueNumbers: number[]): HarnessIssue {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    state: issue.state.toLowerCase() === 'closed' ? 'closed' : 'open',
    labels: issue.labels.map(label => label.name),
    blockedByIssueNumbers,
  };
}

function mapPullRequest(pr: GhPullRequest): HarnessPullRequest {
  return {
    number: pr.number,
    issueNumber: findClosingIssueNumber(pr.body ?? '') ?? pr.number,
    branch: pr.headRefName,
    state: mapPullRequestState(pr.state),
    draft: pr.isDraft,
    labels: pr.labels.map(label => label.name),
    changedFiles: pr.files.map(file => file.path),
    checks: mapCheckState(pr.statusCheckRollup),
    review: mapReviewState(pr.reviewDecision),
    mergeable: pr.mergeable === 'MERGEABLE',
    mergeability: mapMergeabilityState(pr.mergeable),
  };
}

function findClosingIssueNumber(body: string): number | undefined {
  const match = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/i.exec(body);
  if (!match) return undefined;
  return Number(match[1]);
}

function mapPullRequestState(state: string): HarnessPullRequest['state'] {
  if (state === 'MERGED') return 'merged';
  return state === 'CLOSED' ? 'closed' : 'open';
}

function mapCheckState(rollup: GhPullRequest['statusCheckRollup']): CheckState {
  if (rollup.length === 0) return 'pending';
  if (
    rollup.some(check =>
      ['FAILURE', 'ERROR', 'TIMED_OUT', 'ACTION_REQUIRED', 'CANCELLED'].includes(
        check.conclusion ?? check.state ?? ''
      )
    )
  ) {
    return 'failing';
  }
  if (
    rollup.some(check =>
      ['PENDING', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED'].includes(
        check.status ?? check.state ?? ''
      )
    )
  ) {
    return 'pending';
  }
  return 'passing';
}

function mapReviewState(reviewDecision: string): ReviewState {
  if (reviewDecision === 'CHANGES_REQUESTED') return 'changes_requested';
  if (reviewDecision === 'APPROVED') return 'approved';
  return 'none';
}

function mapMergeabilityState(mergeable: string): MergeabilityState {
  if (mergeable === 'MERGEABLE') return 'mergeable';
  if (mergeable === 'CONFLICTING') return 'conflicting';
  return 'unknown';
}

function isGhNotFound(error: unknown): boolean {
  return String(error).includes('not found') || String(error).includes('HTTP 404');
}
