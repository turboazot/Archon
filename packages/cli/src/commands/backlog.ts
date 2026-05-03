import { execFile } from 'child_process';
import { isAbsolute, resolve } from 'path';
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
import type { BacklogProjectConfig, MergedConfig } from '@archon/core/config';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { workflowRunCommand } from './workflow';

const execFileAsync = promisify(execFile);

export interface BacklogCommandOptions {
  cwd: string;
  cycles?: number;
  pollIntervalSeconds?: number;
}

export async function backlogSetupCommand(cwd: string): Promise<void> {
  const runtimes = await createBacklogRuntimes(cwd);
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

  for (const runtime of runtimes) {
    await runProjectStep(runtime, async () => {
      for (const label of labels) {
        await runtime.github.ensureLabel(runtime.config.repo, label);
      }

      const repoInfo = await runtime.github.getRepositoryInfo(runtime.config.repo);
      console.log(`Backlog labels are ready for ${runtime.config.repo}.`);
      console.log(`Project: ${runtime.projectName}`);
      console.log(`Default branch: ${repoInfo.defaultBranch}`);
      if (runtime.config.baseBranch && runtime.config.baseBranch !== repoInfo.defaultBranch) {
        console.log(
          `Warning: configured base branch ${runtime.config.baseBranch} differs from GitHub default ${repoInfo.defaultBranch}; linked PRs will not auto-close issues.`
        );
      }
    });
  }
}

export async function backlogReconcileCommand(cwd: string): Promise<void> {
  const runtimes = await createBacklogRuntimes(cwd);
  for (const runtime of runtimes) {
    console.log(`\nBacklog reconcile for ${runtime.config.repo} (${runtime.projectName})`);
    await runProjectStep(runtime, async () => {
      const report = await runtime.orchestrator.reconcileOnce();
      printReport(report);
      await runtime.archon.drainStartedWorkflows();
    });
  }
}

export async function backlogRunCommand(options: BacklogCommandOptions): Promise<void> {
  const cycles = options.cycles ?? Number.POSITIVE_INFINITY;
  const pollIntervalSeconds = options.pollIntervalSeconds ?? 60;

  for (let cycle = 1; cycle <= cycles; cycle += 1) {
    console.log(`\nBacklog reconcile cycle ${String(cycle)}`);
    const runtimes = await createBacklogRuntimes(options.cwd);
    for (const runtime of runtimes) {
      console.log(`\nProject: ${runtime.projectName}`);
      console.log(`Repo: ${runtime.config.repo}`);
      await runProjectStep(runtime, async () => {
        const report = await runtime.orchestrator.reconcileOnce();
        printReport(report);
      });
    }

    if (cycle >= cycles) break;
    await sleep(pollIntervalSeconds * 1000);
  }
}

export async function backlogStatusCommand(cwd: string): Promise<void> {
  const runtimes = await createBacklogRuntimes(cwd);
  for (const { projectName, config, store, github } of runtimes) {
    await runProjectStep({ projectName, config }, async () => {
      const runs = await store.listRuns(config.repo);
      const repoInfo = await github.getRepositoryInfo(config.repo);
      console.log(`Backlog status for ${config.repo}`);
      console.log(`Project: ${projectName}`);
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
    });
  }
}

interface BacklogRuntime {
  projectName: string;
  config: HarnessOrchestratorConfig;
  github: GitHubGhAdapter;
  store: DbBacklogOrchestratorStore;
  archon: CliWorkflowArchonPort;
  orchestrator: BacklogOrchestrator;
}

async function createBacklogRuntimes(cwd: string): Promise<BacklogRuntime[]> {
  const mergedConfig = await loadConfig(cwd);
  const configuredProjects = normalizeBacklogProjects(mergedConfig.backlog?.projects);
  if (configuredProjects.length > 0) {
    const runtimes: BacklogRuntime[] = [];
    for (const project of configuredProjects) {
      runtimes.push(await createBacklogRuntime(cwd, project, mergedConfig));
    }
    return runtimes;
  }

  if (mergedConfig.backlog?.repo) {
    return [
      await createBacklogRuntime(
        cwd,
        { name: 'configured repo', repo: mergedConfig.backlog.repo, cwd },
        mergedConfig
      ),
    ];
  }

  return [
    await createBacklogRuntime(
      cwd,
      { name: 'current repo', repo: await getCurrentGitHubRepo(cwd), cwd },
      mergedConfig
    ),
  ];
}

async function createBacklogRuntime(
  serviceCwd: string,
  project: BacklogProjectConfig,
  serviceConfig: MergedConfig
): Promise<BacklogRuntime> {
  const projectCwd = resolveProjectCwd(serviceCwd, project.cwd);
  const projectConfig = projectCwd === serviceCwd ? serviceConfig : await loadConfig(projectCwd);
  const serviceBacklog = serviceConfig.backlog ?? {};
  const projectBacklog = projectConfig.backlog ?? {};
  const serviceBacklogConfig = backlogHarnessConfig(serviceBacklog);
  const projectBacklogConfig = backlogHarnessConfig(projectBacklog);
  const { repo, workflowLabelToName: projectWorkflowLabels } = project;
  const projectConfigOverrides = backlogHarnessConfig(project);
  const defaultHarnessConfig = createDefaultHarnessConfig();
  const workflowLabelToName = {
    ...defaultHarnessConfig.workflowLabelToName,
    ...serviceBacklog.workflowLabelToName,
    ...projectBacklog.workflowLabelToName,
    ...projectWorkflowLabels,
  };
  const config = createDefaultHarnessConfig({
    ...serviceBacklogConfig,
    ...projectBacklogConfig,
    ...projectConfigOverrides,
    repo,
    baseBranch:
      projectConfigOverrides.baseBranch ??
      projectConfig.baseBranch ??
      (projectCwd === serviceCwd ? serviceConfig.baseBranch : undefined),
    workflowLabelToName,
  });
  const github = new GitHubGhAdapter();
  const store = new DbBacklogOrchestratorStore();
  const archon = new CliWorkflowArchonPort(projectCwd);
  const orchestrator = new BacklogOrchestrator(config, { github, archon, store });
  return {
    projectName: project.name ?? repo,
    config,
    github,
    store,
    archon,
    orchestrator,
  };
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
  const backlogContext = JSON.stringify({
    repo,
    issueNumber: issue.number,
    prNumber: prNumber ?? null,
    branch,
  });
  return `Fix issue #${String(issue.number)} in ${repo}.${prLine}
Use branch: ${branch}

ARCHON_BACKLOG_CONTEXT_JSON: ${backlogContext}

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

function normalizeBacklogProjects(
  projects: (string | BacklogProjectConfig)[] | undefined
): BacklogProjectConfig[] {
  return (projects ?? []).map(project =>
    typeof project === 'string' ? { repo: project } : project
  );
}

function resolveProjectCwd(serviceCwd: string, projectCwd: string | undefined): string {
  if (!projectCwd?.trim()) return serviceCwd;
  const trimmed = projectCwd.trim();
  return isAbsolute(trimmed) ? trimmed : resolve(serviceCwd, trimmed);
}

async function runProjectStep(
  runtime: Pick<BacklogRuntime, 'projectName' | 'config'>,
  step: () => Promise<void>
): Promise<void> {
  try {
    await step();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `Skipping backlog project ${runtime.projectName} (${runtime.config.repo}): ${message}`
    );
  }
}

export function backlogHarnessConfig(
  config: Partial<BacklogProjectConfig & NonNullable<MergedConfig['backlog']>>
): Partial<HarnessOrchestratorConfig> {
  const result: Partial<HarnessOrchestratorConfig> = {};

  setIfDefined(result, 'maxParallelWorkflows', config.maxParallelWorkflows);
  setIfDefined(result, 'maxOpenAgentPrs', config.maxOpenAgentPrs);
  setIfDefined(result, 'maxNewRunsPerCycle', config.maxNewRunsPerCycle);
  setIfDefined(result, 'maxRunAttempts', config.maxRunAttempts);
  setIfDefined(result, 'maxFixAttempts', config.maxFixAttempts);
  setIfDefined(result, 'conflictWorkflowName', config.conflictWorkflowName);
  setIfDefined(result, 'areaLockPolicy', config.areaLockPolicy);
  setIfDefined(result, 'workflowLabelToName', config.workflowLabelToName);
  setIfDefined(
    result,
    'workflowLabelsCompletingWithoutPr',
    config.workflowLabelsCompletingWithoutPr
  );
  setIfDefined(result, 'autoMergeEnabled', config.autoMergeEnabled);

  return result;
}

function setIfDefined<K extends keyof HarnessOrchestratorConfig>(
  target: Partial<HarnessOrchestratorConfig>,
  key: K,
  value: HarnessOrchestratorConfig[K] | undefined
): void {
  if (value !== undefined) target[key] = value;
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
