import { evaluateIssuesForScheduling, findAreaLabels } from './eligibility';
import {
  ACTIVE_RUN_STATUSES,
  LIFECYCLE_LABELS,
  TERMINAL_RUN_STATUSES,
  WORKFLOW_LABEL_PREFIX,
} from './lifecycle';
import type {
  ArchonPort,
  GitHubPort,
  HarnessIssue,
  HarnessOrchestratorConfig,
  HarnessOrchestratorPorts,
  HarnessPullRequest,
  RepositoryInfo,
  OrchestratorStore,
  StatusReport,
  StoredOrchestratorRun,
} from './types';

export { createDefaultHarnessConfig } from './config';
export type {
  ArchonPort,
  AreaLockPolicy,
  BlockedIssue,
  CheckState,
  GitHubPort,
  HarnessIssue,
  HarnessOrchestratorConfig,
  HarnessOrchestratorPorts,
  HarnessPullRequest,
  HarnessWorkflowRun,
  MergeabilityState,
  OrchestratorRunStatus,
  OrchestratorStore,
  PullRequestState,
  ReviewState,
  StartWorkflowInput,
  StatusReport,
  StoredOrchestratorRun,
  WorkflowRunState,
} from './types';

export class HarnessOrchestrator {
  private readonly config: HarnessOrchestratorConfig;
  private readonly github: GitHubPort;
  private readonly archon: ArchonPort;
  private readonly store: OrchestratorStore;

  constructor(config: HarnessOrchestratorConfig, ports: HarnessOrchestratorPorts) {
    this.config = config;
    this.github = ports.github;
    this.archon = ports.archon;
    this.store = ports.store;
  }

  async reconcileOnce(): Promise<StatusReport> {
    const repositoryInfo = await this.github.getRepositoryInfo(this.config.repo);
    const issues = await this.github.listIssues(this.config.repo);
    const prs = await this.github.listPullRequests(this.config.repo);
    await this.syncKnownRuns(issues);

    const refreshedRuns = await this.store.listRuns(this.config.repo);
    const activeRuns = refreshedRuns.filter(run => ACTIVE_RUN_STATUSES.has(run.status));
    const openAgentPrs = this.findOpenAgentPrs(prs, refreshedRuns);
    const report = this.buildInitialReport(refreshedRuns, openAgentPrs);

    this.addRepositoryWarnings(repositoryInfo, report);
    await this.syncPullRequests(issues, prs, refreshedRuns, report, repositoryInfo);
    await this.scheduleReadyIssues(issues, refreshedRuns, openAgentPrs, activeRuns, report);

    return report;
  }

  private async syncKnownRuns(issues: HarnessIssue[]): Promise<void> {
    const runs = await this.store.listRuns(this.config.repo);
    for (const run of runs) {
      if (TERMINAL_RUN_STATUSES.has(run.status)) continue;
      if (
        run.status !== 'running' &&
        run.status !== 'fix_running' &&
        run.status !== 'conflict_running'
      )
        continue;

      const workflowRun = await this.archon.getWorkflowRun(run.workflowRunId);

      const issue =
        issues.find(candidate => candidate.number === run.issueNumber) ??
        (await this.github.getIssue(this.config.repo, run.issueNumber));
      if (!issue) continue;

      const pr = await this.github.findPullRequestByBranch(this.config.repo, run.branch);
      if (pr) {
        const shouldAdoptOpenPr =
          run.prNumber === undefined ||
          (run.status === 'running' && workflowRun?.state === 'running');
        if (shouldAdoptOpenPr) {
          await this.transitionRun(run, {
            prNumber: pr.number,
            status: 'pr_open',
            changedFiles: pr.changedFiles,
            lastError:
              workflowRun && (workflowRun.state === 'failed' || workflowRun.state === 'cancelled')
                ? (workflowRun.error ?? `Workflow ${workflowRun.state}`)
                : run.lastError,
          });
          await this.github.addIssueLabel(this.config.repo, issue.number, LIFECYCLE_LABELS.prOpen);
          await this.commentOnce(
            run,
            issue.number,
            'pr-opened',
            `PR #${pr.number} is open for ${run.branch}.`
          );
        }
        continue;
      }

      if (!workflowRun || workflowRun.state === 'running') continue;

      if (workflowRun.state === 'failed' || workflowRun.state === 'cancelled') {
        await this.markRunFailed(run, issue, workflowRun.error ?? `Workflow ${workflowRun.state}`);
        continue;
      }

      await this.markRunFailed(
        run,
        issue,
        `Workflow completed but no PR was found for ${run.branch}`
      );
      await this.github.addIssueLabel(this.config.repo, issue.number, LIFECYCLE_LABELS.blocked);
      await this.commentOnce(
        run,
        issue.number,
        'missing-pr',
        `Workflow completed, but no PR was found for branch ${run.branch}.`
      );
      continue;
    }
  }

  private async syncPullRequests(
    issues: HarnessIssue[],
    prs: HarnessPullRequest[],
    runs: StoredOrchestratorRun[],
    report: StatusReport,
    repositoryInfo: RepositoryInfo
  ): Promise<void> {
    for (const run of runs) {
      if (!run.prNumber || TERMINAL_RUN_STATUSES.has(run.status)) continue;

      const issue =
        issues.find(candidate => candidate.number === run.issueNumber) ??
        (await this.github.getIssue(this.config.repo, run.issueNumber));
      const pr = prs.find(candidate => candidate.number === run.prNumber);
      if (!issue || !pr) continue;

      if (!this.isPrLinkedToIssue(pr, issue.number)) {
        await this.transitionRun(run, {
          status: 'blocked',
          lastError: `PR #${pr.number} must contain exactly one closing reference for issue #${issue.number}`,
        });
        await this.github.addIssueLabel(this.config.repo, issue.number, LIFECYCLE_LABELS.blocked);
        await this.commentOnce(
          run,
          issue.number,
          'pr-link-invalid',
          `PR #${pr.number} is not safely linked to this issue. Add exactly one closing keyword such as \`Fixes #${issue.number}\` to the PR body.`
        );
        continue;
      }

      if (pr.state === 'merged') {
        await this.transitionRun(run, {
          status: 'done',
          changedFiles: pr.changedFiles,
        });
        await this.github.addIssueLabel(this.config.repo, issue.number, LIFECYCLE_LABELS.done);
        await this.github.removeIssueLabel(
          this.config.repo,
          issue.number,
          LIFECYCLE_LABELS.inProgress
        );
        await this.commentOnce(run, issue.number, 'merged', `PR #${pr.number} was merged.`);
        continue;
      }

      if (pr.state === 'closed') {
        await this.markRunFailed(run, issue, `PR #${pr.number} closed without merge`);
        continue;
      }

      if (pr.mergeability === 'conflicting') {
        await this.handlePrConflict(run, issue, pr);
        continue;
      }

      if (pr.checks === 'failing' || pr.review === 'changes_requested') {
        await this.handlePrNeedsFix(run, issue, pr);
        continue;
      }

      if (pr.checks === 'passing') {
        await this.transitionRun(run, {
          status: 'ready_for_review',
          changedFiles: pr.changedFiles,
        });
        await this.github.removeIssueLabel(
          this.config.repo,
          issue.number,
          LIFECYCLE_LABELS.inProgress
        );
        await this.github.addIssueLabel(
          this.config.repo,
          issue.number,
          LIFECYCLE_LABELS.readyForReview
        );
        await this.commentOnce(
          run,
          issue.number,
          'validated',
          `PR #${pr.number} passed validation and is ready for review.`
        );

        if (this.isAutoMergeCandidate(issue, pr, run, repositoryInfo)) {
          report.autoMergeCandidates.push(pr);
          if (this.config.autoMergeEnabled) {
            await this.github.mergePullRequest(this.config.repo, pr.number);
          }
        } else {
          report.readyForHumanReview.push(pr);
        }
      }
    }
  }

  private async handlePrNeedsFix(
    run: StoredOrchestratorRun,
    issue: HarnessIssue,
    pr: HarnessPullRequest
  ): Promise<void> {
    await this.github.addIssueLabel(this.config.repo, issue.number, LIFECYCLE_LABELS.needsFix);

    if (run.status === 'fix_running') {
      return;
    }

    if (run.fixAttempts >= this.config.maxFixAttempts) {
      await this.transitionRun(run, {
        status: 'needs_fix',
        lastError: `PR #${pr.number} needs fixes and retry budget is exhausted`,
      });
      await this.commentOnce(
        run,
        issue.number,
        'retry-exhausted',
        `PR #${pr.number} needs fixes, but the retry budget is exhausted.`
      );
      return;
    }

    const fixWorkflow = await this.archon.startWorkflow({
      repo: this.config.repo,
      issue,
      workflowName: 'fix-pr',
      branch: run.branch,
      prNumber: pr.number,
      mode: 'fix',
    });

    await this.transitionRun(run, {
      workflowRunId: fixWorkflow.id,
      status: 'fix_running',
      fixAttempts: run.fixAttempts + 1,
      lastError: pr.checks === 'failing' ? 'Required checks failed' : 'Review requested changes',
    });
    await this.commentOnce(
      run,
      issue.number,
      `fix-${run.fixAttempts + 1}`,
      `Scheduled fix attempt ${run.fixAttempts + 1} for PR #${pr.number}.`
    );
  }

  private async handlePrConflict(
    run: StoredOrchestratorRun,
    issue: HarnessIssue,
    pr: HarnessPullRequest
  ): Promise<void> {
    await this.github.addIssueLabel(this.config.repo, issue.number, LIFECYCLE_LABELS.needsFix);

    if (run.status === 'conflict_running') {
      return;
    }

    if (run.fixAttempts >= this.config.maxFixAttempts) {
      await this.transitionRun(run, {
        status: 'needs_fix',
        lastError: `PR #${pr.number} has merge conflicts and retry budget is exhausted`,
      });
      await this.commentOnce(
        run,
        issue.number,
        'conflict-retry-exhausted',
        `PR #${pr.number} has merge conflicts, but the retry budget is exhausted.`
      );
      return;
    }

    const conflictWorkflow = await this.archon.startWorkflow({
      repo: this.config.repo,
      issue,
      workflowName: this.config.conflictWorkflowName,
      branch: run.branch,
      prNumber: pr.number,
      mode: 'conflict',
    });

    await this.transitionRun(run, {
      workflowRunId: conflictWorkflow.id,
      status: 'conflict_running',
      fixAttempts: run.fixAttempts + 1,
      lastError: `PR #${pr.number} has merge conflicts`,
    });
    await this.commentOnce(
      run,
      issue.number,
      `conflict-${run.fixAttempts + 1}`,
      `Scheduled conflict resolution attempt ${run.fixAttempts + 1} for PR #${pr.number}.`
    );
  }

  private async scheduleReadyIssues(
    issues: HarnessIssue[],
    runs: StoredOrchestratorRun[],
    openAgentPrs: HarnessPullRequest[],
    activeRuns: StoredOrchestratorRun[],
    report: StatusReport
  ): Promise<void> {
    let remainingWorkflowCapacity = this.config.maxParallelWorkflows - activeRuns.length;
    let remainingPrCapacity = this.config.maxOpenAgentPrs - openAgentPrs.length;
    let startedThisCycle = 0;

    for (const result of evaluateIssuesForScheduling({
      issues,
      runs,
      activeRuns,
      openAgentPrs,
      areaLockPolicy: this.config.areaLockPolicy,
    })) {
      if (result.blockedReason) {
        report.blockedIssues.push({ issue: result.issue, reason: result.blockedReason });
        await this.markIssueBlocked(result.issue, result.blockedReason);
        continue;
      }

      if (!result.workflowLabel) continue;

      const noCapacity =
        remainingWorkflowCapacity <= 0 ||
        remainingPrCapacity <= 0 ||
        startedThisCycle >= this.config.maxNewRunsPerCycle;

      if (noCapacity) {
        report.waitingForCapacity.push(result.issue);
        continue;
      }

      report.nextEligibleIssues.push(result.issue);
      const startedRun = await this.startIssue(result.issue, result.workflowLabel);
      report.startedRuns.push(startedRun);
      remainingWorkflowCapacity -= 1;
      remainingPrCapacity -= 1;
      startedThisCycle += 1;
    }
  }

  private async startIssue(
    issue: HarnessIssue,
    workflowLabel: string
  ): Promise<StoredOrchestratorRun> {
    const workflowName =
      this.config.workflowLabelToName[workflowLabel] ??
      workflowLabel.slice(WORKFLOW_LABEL_PREFIX.length);
    const workflowRun = await this.archon.startWorkflow({
      repo: this.config.repo,
      issue,
      workflowName,
      mode: 'implement',
    });

    const now = this.config.now();
    const run: StoredOrchestratorRun = {
      id: `orchestrator-${issue.number}-${now.getTime()}`,
      repo: this.config.repo,
      issueNumber: issue.number,
      workflowRunId: workflowRun.id,
      branch: workflowRun.branch,
      status: 'running',
      workflowLabel,
      areaLabels: findAreaLabels(issue.labels),
      changedFiles: [],
      startedAt: now,
      updatedAt: now,
      runAttempts: 1,
      fixAttempts: 0,
      commentKeys: [],
    };

    await this.store.createRun(run);
    await this.clearResolvedDependencies(issue);
    await this.github.removeIssueLabel(this.config.repo, issue.number, LIFECYCLE_LABELS.ready);
    await this.github.removeIssueLabel(this.config.repo, issue.number, LIFECYCLE_LABELS.blocked);
    await this.github.addIssueLabel(this.config.repo, issue.number, LIFECYCLE_LABELS.inProgress);
    await this.commentOnce(
      run,
      issue.number,
      'started',
      `Started ${workflowName} as ${workflowRun.id} on ${workflowRun.branch}.`
    );
    return run;
  }

  private async markIssueBlocked(issue: HarnessIssue, reason: string): Promise<void> {
    if (issue.labels.includes(LIFECYCLE_LABELS.blocked)) return;
    await this.github.addIssueLabel(this.config.repo, issue.number, LIFECYCLE_LABELS.blocked);
    await this.github.addIssueComment(this.config.repo, issue.number, reason);
  }

  private async clearResolvedDependencies(issue: HarnessIssue): Promise<void> {
    for (const blockingIssueNumber of issue.blockedByIssueNumbers) {
      const blockingIssue = await this.github.getIssue(this.config.repo, blockingIssueNumber);
      if (blockingIssue?.state !== 'closed') continue;
      await this.github.removeIssueBlockedBy(this.config.repo, issue.number, blockingIssueNumber);
    }
  }

  private async markRunFailed(
    run: StoredOrchestratorRun,
    issue: HarnessIssue,
    lastError: string
  ): Promise<void> {
    if (run.status === 'running' && run.runAttempts < this.config.maxRunAttempts) {
      await this.retryRun(run, issue, lastError);
      return;
    }

    await this.transitionRun(run, {
      status: 'failed',
      lastError,
    });
    await this.github.removeIssueLabel(this.config.repo, issue.number, LIFECYCLE_LABELS.inProgress);
    await this.github.addIssueLabel(this.config.repo, issue.number, LIFECYCLE_LABELS.blocked);
    await this.commentOnce(run, issue.number, 'failed', `Workflow failed: ${lastError}`);
  }

  private async retryRun(
    run: StoredOrchestratorRun,
    issue: HarnessIssue,
    lastError: string
  ): Promise<void> {
    const workflowName =
      this.config.workflowLabelToName[run.workflowLabel] ??
      run.workflowLabel.slice(WORKFLOW_LABEL_PREFIX.length);
    const nextAttempt = run.runAttempts + 1;
    const workflowRun = await this.archon.startWorkflow({
      repo: this.config.repo,
      issue,
      workflowName,
      branch: run.branch,
      mode: 'implement',
    });

    await this.transitionRun(run, {
      workflowRunId: workflowRun.id,
      status: 'running',
      runAttempts: nextAttempt,
      lastError,
    });
    await this.github.removeIssueLabel(this.config.repo, issue.number, LIFECYCLE_LABELS.blocked);
    await this.github.addIssueLabel(this.config.repo, issue.number, LIFECYCLE_LABELS.inProgress);
    await this.commentOnce(
      run,
      issue.number,
      `retry-run-${nextAttempt}`,
      `Retrying workflow after failure (${lastError}). Attempt ${nextAttempt} of ${this.config.maxRunAttempts}.`
    );
  }

  private async transitionRun(
    run: StoredOrchestratorRun,
    updates: Partial<Omit<StoredOrchestratorRun, 'id' | 'repo' | 'issueNumber' | 'startedAt'>>
  ): Promise<void> {
    await this.store.updateRun({
      ...run,
      ...updates,
      updatedAt: this.config.now(),
    });
  }

  private async commentOnce(
    run: StoredOrchestratorRun,
    issueNumber: number,
    key: string,
    body: string
  ): Promise<void> {
    const currentRun = await this.findCurrentRun(run);
    if (currentRun.commentKeys.includes(key)) return;
    await this.github.addIssueComment(this.config.repo, issueNumber, body);
    await this.store.updateRun({
      ...currentRun,
      commentKeys: [...currentRun.commentKeys, key],
      updatedAt: this.config.now(),
    });
  }

  private async findCurrentRun(run: StoredOrchestratorRun): Promise<StoredOrchestratorRun> {
    const runs = await this.store.listRuns(this.config.repo);
    return runs.find(candidate => candidate.id === run.id) ?? run;
  }

  private findOpenAgentPrs(
    prs: HarnessPullRequest[],
    runs: StoredOrchestratorRun[]
  ): HarnessPullRequest[] {
    const trackedPrNumbers = new Set(
      runs.map(run => run.prNumber).filter(prNumber => prNumber !== undefined)
    );
    return prs.filter(pr => pr.state === 'open' && trackedPrNumbers.has(pr.number));
  }

  private buildInitialReport(
    runs: StoredOrchestratorRun[],
    openAgentPrs: HarnessPullRequest[]
  ): StatusReport {
    return {
      activeRuns: runs.filter(run => ACTIVE_RUN_STATUSES.has(run.status)),
      openAgentPrs,
      readyForHumanReview: [],
      autoMergeCandidates: [],
      waitingForCapacity: [],
      blockedIssues: [],
      nextEligibleIssues: [],
      failedRuns: runs.filter(run => run.status === 'failed'),
      startedRuns: [],
      warnings: [],
    };
  }

  private addRepositoryWarnings(repositoryInfo: RepositoryInfo, report: StatusReport): void {
    const baseBranch = this.config.baseBranch ?? repositoryInfo.defaultBranch;
    if (baseBranch !== repositoryInfo.defaultBranch) {
      report.warnings.push(
        `GitHub issue auto-close only works for PRs targeting the default branch (${repositoryInfo.defaultBranch}); configured base branch is ${baseBranch}.`
      );
    }
    if (repositoryInfo.autoCloseIssuesEnabled === false) {
      report.warnings.push(
        'GitHub repository auto-close for merged linked pull requests appears to be disabled.'
      );
    }
  }

  private isPrLinkedToIssue(pr: HarnessPullRequest, issueNumber: number): boolean {
    return pr.closingIssueNumbers.length === 1 && pr.closingIssueNumbers[0] === issueNumber;
  }

  private isAutoMergeCandidate(
    issue: HarnessIssue,
    pr: HarnessPullRequest,
    run: StoredOrchestratorRun,
    repositoryInfo: RepositoryInfo
  ): boolean {
    const baseBranch = this.config.baseBranch ?? repositoryInfo.defaultBranch;
    return (
      issue.labels.includes(LIFECYCLE_LABELS.autoMerge) &&
      pr.issueNumber === issue.number &&
      pr.closingIssueNumbers.length === 1 &&
      pr.closingIssueNumbers[0] === issue.number &&
      pr.baseBranch === repositoryInfo.defaultBranch &&
      baseBranch === repositoryInfo.defaultBranch &&
      repositoryInfo.autoCloseIssuesEnabled !== false &&
      pr.state === 'open' &&
      !pr.draft &&
      pr.checks === 'passing' &&
      pr.review !== 'changes_requested' &&
      pr.mergeable &&
      run.status !== 'fix_running'
    );
  }
}

export { HarnessOrchestrator as BacklogOrchestrator };
