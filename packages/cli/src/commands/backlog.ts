import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  BacklogOrchestrator,
  DbBacklogOrchestratorStore,
  createDefaultHarnessConfig,
  LIFECYCLE_LABELS,
  type ArchonPort,
  type HarnessIssue,
  type HarnessOrchestratorConfig,
  type HarnessWorkflowRun,
  type StartWorkflowInput,
  type StatusReport,
  type WorkflowRunState,
} from '@archon/backlog-orchestrator';
import { GitHubGhAdapter } from '@archon/backlog-orchestrator/adapters/github-gh';
import { loadConfig } from '@archon/core/config';
import * as workflowDb from '@archon/core/db/workflows';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { workflowRunCommand } from './workflow';

const execFileAsync = promisify(execFile);

export interface BacklogCommandOptions {
  cwd: string;
  cycles?: number;
  pollIntervalSeconds?: number;
}

export async function backlogSetupCommand(cwd: string): Promise<void> {
  const { github, config } = await createBacklogRuntime(cwd);
  const labels = [
    LIFECYCLE_LABELS.ready,
    LIFECYCLE_LABELS.inProgress,
    LIFECYCLE_LABELS.blocked,
    LIFECYCLE_LABELS.prOpen,
    LIFECYCLE_LABELS.readyForReview,
    LIFECYCLE_LABELS.needsFix,
    LIFECYCLE_LABELS.done,
    LIFECYCLE_LABELS.autoMerge,
  ];

  for (const label of labels) {
    await github.ensureLabel(config.repo, label);
  }

  const repoInfo = await github.getRepositoryInfo(config.repo);
  console.log(`Backlog labels are ready for ${config.repo}.`);
  console.log(`Default branch: ${repoInfo.defaultBranch}`);
  if (config.baseBranch && config.baseBranch !== repoInfo.defaultBranch) {
    console.log(
      `Warning: configured base branch ${config.baseBranch} differs from GitHub default ${repoInfo.defaultBranch}; linked PRs will not auto-close issues.`
    );
  }
}

export async function backlogReconcileCommand(cwd: string): Promise<void> {
  const runtime = await createBacklogRuntime(cwd);
  const report = await runtime.orchestrator.reconcileOnce();
  printReport(report);
  await runtime.archon.drainStartedWorkflows();
}

export async function backlogRunCommand(options: BacklogCommandOptions): Promise<void> {
  const runtime = await createBacklogRuntime(options.cwd);
  const cycles = options.cycles ?? Number.POSITIVE_INFINITY;
  const pollIntervalSeconds = options.pollIntervalSeconds ?? 60;

  for (let cycle = 1; cycle <= cycles; cycle += 1) {
    console.log(`\nBacklog reconcile cycle ${String(cycle)}`);
    const report = await runtime.orchestrator.reconcileOnce();
    printReport(report);

    if (cycle >= cycles) break;
    await sleep(pollIntervalSeconds * 1000);
  }
}

export async function backlogStatusCommand(cwd: string): Promise<void> {
  const { config, store, github } = await createBacklogRuntime(cwd);
  const runs = await store.listRuns(config.repo);
  const repoInfo = await github.getRepositoryInfo(config.repo);
  console.log(`Backlog status for ${config.repo}`);
  console.log(`Default branch: ${repoInfo.defaultBranch}`);
  if (repoInfo.autoCloseIssuesEnabled === false) {
    console.log('Warning: GitHub auto-close for merged linked PRs appears disabled.');
  }
  if (runs.length === 0) {
    console.log('No backlog orchestrator runs recorded.');
    return;
  }
  for (const run of runs) {
    const pr = run.prNumber ? ` PR #${String(run.prNumber)}` : '';
    const error = run.lastError ? ` (${run.lastError})` : '';
    console.log(
      `#${String(run.issueNumber)} ${run.status}${pr} ${run.workflowLabel} ${run.branch}${error}`
    );
  }
}

async function createBacklogRuntime(cwd: string): Promise<{
  config: HarnessOrchestratorConfig;
  github: GitHubGhAdapter;
  store: DbBacklogOrchestratorStore;
  archon: CliWorkflowArchonPort;
  orchestrator: BacklogOrchestrator;
}> {
  const mergedConfig = await loadConfig(cwd);
  const repo = mergedConfig.backlog?.repo ?? (await getCurrentGitHubRepo(cwd));
  const config = createDefaultHarnessConfig({
    ...mergedConfig.backlog,
    repo,
    baseBranch: mergedConfig.baseBranch,
  });
  const github = new GitHubGhAdapter({
    allowMerge: process.env.ARCHON_BACKLOG_ALLOW_MERGE === '1',
  });
  const store = new DbBacklogOrchestratorStore();
  const archon = new CliWorkflowArchonPort(cwd);
  const orchestrator = new BacklogOrchestrator(config, { github, archon, store });
  return { config, github, store, archon, orchestrator };
}

class CliWorkflowArchonPort implements ArchonPort {
  private readonly startedWorkflowPromises: Promise<void>[] = [];

  constructor(private readonly cwd: string) {}

  async startWorkflow(input: StartWorkflowInput): Promise<HarnessWorkflowRun> {
    const branch = input.branch ?? `archon/issue-${String(input.issue.number)}`;
    const conversationId = `cli-backlog-${sanitizeId(input.repo)}-${String(
      input.issue.number
    )}-${Date.now().toString()}`;
    const message = buildWorkflowMessage(input.issue, input.repo, branch, input.prNumber);

    const workflowPromise = workflowRunCommand(this.cwd, input.workflowName, message, {
      branchName: branch,
      conversationId,
      quiet: true,
    }).catch((error: unknown) => {
      const err = error as Error;
      console.error(`Backlog workflow ${input.workflowName} failed: ${err.message}`);
    });
    this.startedWorkflowPromises.push(workflowPromise);

    const workflowRun = await waitForWorkflowRun(conversationId);
    void workflowPromise;
    return {
      id: workflowRun.id,
      workflowName: workflowRun.workflow_name,
      issueNumber: input.issue.number,
      branch,
      state: mapWorkflowStatus(workflowRun.status),
    };
  }

  async getWorkflowRun(runId: string): Promise<HarnessWorkflowRun | undefined> {
    const run = await workflowDb.getWorkflowRun(runId);
    if (!run) return undefined;
    return {
      id: run.id,
      workflowName: run.workflow_name,
      issueNumber: extractIssueNumber(run.user_message) ?? 0,
      branch: run.working_path ?? '',
      state: mapWorkflowStatus(run.status),
      error: typeof run.metadata.error === 'string' ? run.metadata.error : undefined,
    };
  }

  async drainStartedWorkflows(): Promise<void> {
    await Promise.allSettled(this.startedWorkflowPromises);
  }
}

async function waitForWorkflowRun(conversationId: string): Promise<WorkflowRun> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = await workflowDb.getWorkflowRunByWorkerPlatformId(conversationId);
    if (run) return run;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for workflow run to start for ${conversationId}`);
}

function buildWorkflowMessage(
  issue: HarnessIssue,
  repo: string,
  branch: string,
  prNumber?: number
): string {
  const prLine = prNumber ? `\nPR: #${String(prNumber)}` : '';
  return `Fix issue #${String(issue.number)} in ${repo}.${prLine}
Use branch: ${branch}

Issue title: ${issue.title}

${issue.body}`;
}

function mapWorkflowStatus(status: string): WorkflowRunState {
  if (status === 'completed') return 'succeeded';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'failed') return 'failed';
  return 'running';
}

function printReport(report: StatusReport): void {
  for (const warning of report.warnings) {
    console.log(`Warning: ${warning}`);
  }
  if (report.startedRuns.length > 0) {
    console.log(`Started: ${report.startedRuns.map(run => `#${run.issueNumber}`).join(', ')}`);
  }
  if (report.blockedIssues.length > 0) {
    console.log(
      `Blocked: ${report.blockedIssues
        .map(blocked => `#${blocked.issue.number} (${blocked.reason})`)
        .join(', ')}`
    );
  }
  if (report.readyForHumanReview.length > 0) {
    console.log(
      `Ready for review: ${report.readyForHumanReview.map(pr => `#${pr.number}`).join(', ')}`
    );
  }
  if (report.autoMergeCandidates.length > 0) {
    console.log(
      `Auto-merge candidates: ${report.autoMergeCandidates.map(pr => `#${pr.number}`).join(', ')}`
    );
  }
  if (
    report.startedRuns.length === 0 &&
    report.blockedIssues.length === 0 &&
    report.readyForHumanReview.length === 0 &&
    report.autoMergeCandidates.length === 0
  ) {
    console.log('No backlog changes this cycle.');
  }
}

async function getCurrentGitHubRepo(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'gh',
    ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
    { cwd, timeout: 30_000 }
  );
  return stdout.trim();
}

function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, '-');
}

function extractIssueNumber(message: string): number | undefined {
  const match = /issue\s+#?(\d+)/i.exec(message);
  return match ? Number(match[1]) : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
