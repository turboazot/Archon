import { mkdir, readFile, readdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { loadConfig } from '@archon/core/config';
import type { BacklogProjectConfig } from '@archon/core/config';
import { GitHubGhAdapter } from '../src/adapters/github-gh';
import {
  DEMO_WORKFLOW_LABELS_COMPLETING_WITHOUT_PR,
  DEMO_WORKFLOW_LABEL_TO_NAME,
  createDefaultHarnessConfig,
  HarnessOrchestrator,
} from '../src/orchestrator';
import { LIFECYCLE_LABELS } from '../src/lifecycle';
import type { HarnessIssue, StatusReport } from '../src/types';
import { ArchonRestAdapter } from './support/archon-rest';
import { SqliteOrchestratorStore } from './support/sqlite-store';

const RESULTS_ROOT = join(import.meta.dir, 'results');
const DEFAULT_ENV_FILE = resolveDefaultEnvFile();
const TEST_LABEL = 'archon-test';
const TINY_ROUTING_LABEL = 'archon-workflow:tiny';
const SELF_MERGE_ROUTING_LABEL = 'archon-workflow:tiny-self-merge';
const SIMPLE_FIX_ROUTING_LABEL = 'archon-workflow:fix-issue-simple';
const VIDEO_RECORDING_ROUTING_LABEL = 'archon-workflow:video-recording';
const ISSUE_SIZES = ['tiny', 'small'] as const;
const SCENARIOS = [
  'single',
  'single-auto-merge',
  'blocked-parallel',
  'ecommerce-app',
  'ecommerce-app-auto-merge',
  'video-recording',
] as const;

type IssueSize = (typeof ISSUE_SIZES)[number];
type LiveScenario = (typeof SCENARIOS)[number];

interface LiveArgs {
  cycles: number;
  repo?: string;
  project?: string;
  delayMs: number;
  sessionId: string;
  issueSize: IssueSize;
  branchName?: string;
  envFile: string;
  preflightOnly: boolean;
  resumeExisting: boolean;
  scenario: LiveScenario;
}

interface LiveTarget {
  name: string;
  repo: string;
  cwd?: string;
  codebaseUrl: string;
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  await loadEnvFile(args.envFile);
  const target = await resolveLiveTarget(args);
  const env = validateEnv();
  const resultDir = join(RESULTS_ROOT, args.sessionId);
  await mkdir(resultDir, { recursive: true });

  const github = new GitHubGhAdapter();
  const archon = new ArchonRestAdapter({
    baseUrl: env.archonBaseUrl,
    codebaseUrl: target.codebaseUrl,
    codebaseCwd: target.cwd,
    token: env.archonApiToken,
    sessionId: args.sessionId,
    branchName: args.branchName,
  });
  const store = new SqliteOrchestratorStore(join(resultDir, 'orchestrator.sqlite'));

  try {
    await archon.checkHealth();
    await github.listIssues(target.repo);
    if (args.preflightOnly) {
      console.log('Live E2E preflight passed');
      console.log(`Project: ${target.name}`);
      console.log(`Repo: ${target.repo}`);
      console.log(`Archon: ${env.archonBaseUrl}`);
      console.log(`Branch: ${args.branchName ?? 'per issue'}`);
      console.log(`Issue size: ${args.issueSize}`);
      console.log(`Scenario: ${args.scenario}`);
      console.log(`Resume existing: ${args.resumeExisting ? 'yes' : 'no'}`);
      return;
    }

    await ensureHarnessLabels(github, target.repo);
    const issues = args.resumeExisting
      ? await loadExistingScenarioIssues({ github, args, target, resultDir })
      : await createScenarioIssues(github, args, target);

    const orchestrator = new HarnessOrchestrator(
      createDefaultHarnessConfig({
        repo: target.repo,
        autoMergeEnabled: false,
        maxParallelWorkflows: parallelScenarioLimit(args.scenario),
        maxOpenAgentPrs: parallelScenarioLimit(args.scenario),
        maxNewRunsPerCycle: maxNewRunsPerCycle(args.scenario),
        areaLockPolicy: args.scenario === 'single' ? 'conservative' : 'none',
        workflowLabelToName: {
          ...createDefaultHarnessConfig().workflowLabelToName,
          ...DEMO_WORKFLOW_LABEL_TO_NAME,
        },
        workflowLabelsCompletingWithoutPr: [...DEMO_WORKFLOW_LABELS_COMPLETING_WITHOUT_PR],
      }),
      { github, archon, store }
    );

    const reports: StatusReport[] = [];
    let completedEarly = false;
    for (let cycle = 1; cycle <= args.cycles; cycle += 1) {
      const report = await orchestrator.reconcileOnce();
      reports.push(report);
      await writeCycleArtifact({
        resultDir,
        cycle,
        report,
        repo: target.repo,
        issueNumbers: issues.map(issue => issue.number),
        github,
        store,
      });
      if (await isScenarioComplete({ args, github, store, issues, target })) {
        completedEarly = true;
        console.log(`Scenario ${args.scenario} reached completion condition at cycle ${cycle}`);
        break;
      }
      if (cycle < args.cycles) await sleep(args.delayMs);
    }

    const finalState = {
      issues: await github.listIssues(target.repo),
      pullRequests: await github.listPullRequests(target.repo),
      runs: await store.listRuns(target.repo),
    };

    await writeFile(
      join(resultDir, 'result.json'),
      JSON.stringify(
        {
          sessionId: args.sessionId,
          project: target.name,
          repo: target.repo,
          codebaseCwd: target.cwd ?? null,
          scenario: args.scenario,
          issueSize: args.issueSize,
          branchName: args.branchName ?? null,
          issues,
          reports,
          completedEarly,
          finalState,
          safety: {
            liveGate: 'smoke:live command',
            markerLabel: TEST_LABEL,
            branchName: args.branchName ?? null,
          },
        },
        null,
        2
      )
    );

    console.log(`Live E2E session ${args.sessionId} finished`);
    console.log(`Issues: ${issues.map(issue => `#${String(issue.number)}`).join(', ')}`);
    console.log(`Artifacts: ${resultDir}`);
    if (!completedEarly) {
      throw new Error(
        `Scenario ${args.scenario} did not reach completion within ${String(args.cycles)} cycles`
      );
    }
  } finally {
    store.close();
  }
}

async function ensureHarnessLabels(github: GitHubGhAdapter, repo: string): Promise<void> {
  const labels = [
    TEST_LABEL,
    ...Object.values(LIFECYCLE_LABELS),
    TINY_ROUTING_LABEL,
    SELF_MERGE_ROUTING_LABEL,
    SIMPLE_FIX_ROUTING_LABEL,
    VIDEO_RECORDING_ROUTING_LABEL,
    'area:test',
  ];
  for (const label of labels) {
    await github.ensureLabel(repo, label, label === TEST_LABEL ? 'd4c5f9' : '5319e7');
  }
}

async function writeCycleArtifact(input: {
  resultDir: string;
  cycle: number;
  report: StatusReport;
  repo: string;
  issueNumbers: number[];
  github: GitHubGhAdapter;
  store: SqliteOrchestratorStore;
}): Promise<void> {
  await writeFile(
    join(input.resultDir, `cycle-${String(input.cycle)}.json`),
    JSON.stringify(
      {
        cycle: input.cycle,
        report: input.report,
        trackedIssues: await Promise.all(
          input.issueNumbers.map(issueNumber => input.github.getIssue(input.repo, issueNumber))
        ),
        pullRequests: await input.github.listPullRequests(input.repo),
        runs: await input.store.listRuns(input.repo),
      },
      null,
      2
    )
  );
}

function parseArgs(argv: string[]): LiveArgs {
  let cycles: number | undefined;
  let repo: string | undefined;
  let project: string | undefined;
  let delayMs = 10_000;
  let sessionId = new Date().toISOString().replace(/[:.]/g, '-');
  let issueSize: IssueSize = 'tiny';
  let envFile = DEFAULT_ENV_FILE;
  let preflightOnly = false;
  let resumeExisting = false;
  let scenario: LiveScenario = 'single';

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--cycles' && next) {
      cycles = Number(next);
      index += 1;
    } else if (arg === '--repo' && next) {
      repo = next;
      index += 1;
    } else if (arg === '--project' && next) {
      project = next;
      index += 1;
    } else if (arg === '--delay-ms' && next) {
      delayMs = Number(next);
      index += 1;
    } else if (arg === '--session' && next) {
      sessionId = next;
      index += 1;
    } else if (arg === '--issue-size' && next) {
      if (!isIssueSize(next)) {
        throw new Error(`--issue-size must be one of: ${ISSUE_SIZES.join(', ')}`);
      }
      issueSize = next;
      index += 1;
    } else if (arg === '--env-file' && next) {
      envFile = next;
      index += 1;
    } else if (arg === '--preflight') {
      preflightOnly = true;
    } else if (arg === '--resume-existing') {
      resumeExisting = true;
    } else if (arg === '--scenario' && next) {
      if (!isScenario(next)) {
        throw new Error(`--scenario must be one of: ${SCENARIOS.join(', ')}`);
      }
      scenario = next;
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  const resolvedCycles = cycles ?? (isLongRunningLiveScenario(scenario) ? 120 : 3);
  if (!Number.isInteger(resolvedCycles) || resolvedCycles < 1 || resolvedCycles > 240) {
    throw new Error('--cycles must be an integer from 1 to 240');
  }
  if (!Number.isInteger(delayMs) || delayMs < 0) {
    throw new Error('--delay-ms must be a non-negative integer');
  }
  if (repo && !repo.includes('/')) throw new Error('--repo must be owner/name');
  if (resumeExisting && !argv.includes('--session')) {
    throw new Error('--resume-existing requires --session <existing-session-id>');
  }
  return {
    cycles: resolvedCycles,
    repo,
    project,
    delayMs,
    sessionId,
    issueSize,
    branchName:
      scenario === 'single' || scenario === 'single-auto-merge' || scenario === 'video-recording'
        ? `archon-test/${sessionId}`
        : undefined,
    envFile,
    preflightOnly,
    resumeExisting,
    scenario,
  };
}

async function loadEnvFile(path: string): Promise<void> {
  if (!existsSync(path)) return;
  const content = await readFile(path, 'utf-8');
  let loaded = 0;
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    const [key, value] = parsed;
    if (process.env[key] !== undefined) continue;
    process.env[key] = value;
    loaded += 1;
  }
  if (loaded > 0) {
    process.stderr.write(`[archon-test] loaded ${String(loaded)} keys from ${path}\n`);
  }
}

function parseEnvLine(line: string): [string, string] | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return undefined;
  const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
  if (!match) return undefined;

  const key = match[1];
  let value = stripInlineComment(match[2].trim());
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return [key, value.replace(/\\n/g, '\n')];
}

function stripInlineComment(value: string): string {
  if (value.startsWith('"') || value.startsWith("'")) return value;
  const commentIndex = value.indexOf(' #');
  return commentIndex === -1 ? value : value.slice(0, commentIndex).trimEnd();
}

async function createScenarioIssues(
  github: GitHubGhAdapter,
  args: LiveArgs,
  target: LiveTarget
): Promise<HarnessIssue[]> {
  if (args.scenario === 'single') {
    const issueContent = buildIssueContent(args);
    const issue = await github.createIssue({
      repo: target.repo,
      title: issueContent.title,
      body: issueContent.body,
      labels: [TEST_LABEL, LIFECYCLE_LABELS.ready, TINY_ROUTING_LABEL, 'area:test'],
    });
    return [issue];
  }

  if (args.scenario === 'single-auto-merge') {
    const issue = await github.createIssue({
      repo: target.repo,
      title: `[archon-test:${args.sessionId}] Single auto-merge smoke issue`,
      body: buildSelfMergeIssueBody({
        args,
        role: 'single-auto-merge',
      }),
      labels: [
        TEST_LABEL,
        LIFECYCLE_LABELS.ready,
        SELF_MERGE_ROUTING_LABEL,
        LIFECYCLE_LABELS.autoMerge,
        'area:test',
      ],
    });
    return [issue];
  }

  if (args.scenario === 'video-recording') {
    const issue = await github.createIssue({
      repo: target.repo,
      title: `[archon-test:${args.sessionId}] UI video recording smoke issue`,
      body: buildVideoRecordingIssueBody(args),
      labels: [TEST_LABEL, LIFECYCLE_LABELS.ready, VIDEO_RECORDING_ROUTING_LABEL, 'area:test'],
    });
    return [issue];
  }

  if (isEcommerceScenario(args.scenario)) {
    return createEcommerceAppIssues(github, args, target, {
      autoMergeAll: args.scenario === 'ecommerce-app-auto-merge',
    });
  }

  const skeleton = await github.createIssue({
    repo: target.repo,
    title: `[archon-test:${args.sessionId}] Skeleton smoke issue`,
    body: buildSelfMergeIssueBody({
      args,
      role: 'skeleton',
    }),
    labels: [
      TEST_LABEL,
      LIFECYCLE_LABELS.ready,
      SELF_MERGE_ROUTING_LABEL,
      LIFECYCLE_LABELS.autoMerge,
      'area:test',
    ],
  });

  const firstBlocked = await github.createIssue({
    repo: target.repo,
    title: `[archon-test:${args.sessionId}] Blocked parallel smoke A`,
    body: buildSelfMergeIssueBody({
      args,
      role: 'parallel-a',
    }),
    labels: [
      TEST_LABEL,
      LIFECYCLE_LABELS.ready,
      SELF_MERGE_ROUTING_LABEL,
      LIFECYCLE_LABELS.autoMerge,
      'area:test',
    ],
  });

  const secondBlocked = await github.createIssue({
    repo: target.repo,
    title: `[archon-test:${args.sessionId}] Blocked parallel smoke B`,
    body: buildSelfMergeIssueBody({
      args,
      role: 'parallel-b',
    }),
    labels: [
      TEST_LABEL,
      LIFECYCLE_LABELS.ready,
      SELF_MERGE_ROUTING_LABEL,
      LIFECYCLE_LABELS.autoMerge,
      'area:test',
    ],
  });

  await github.addIssueBlockedBy(target.repo, firstBlocked.number, skeleton.number);
  await github.addIssueBlockedBy(target.repo, secondBlocked.number, skeleton.number);

  const hydratedFirstBlocked = await github.getIssue(target.repo, firstBlocked.number);
  const hydratedSecondBlocked = await github.getIssue(target.repo, secondBlocked.number);

  return [skeleton, hydratedFirstBlocked ?? firstBlocked, hydratedSecondBlocked ?? secondBlocked];
}

async function loadExistingScenarioIssues(input: {
  github: GitHubGhAdapter;
  args: LiveArgs;
  target: LiveTarget;
  resultDir: string;
}): Promise<HarnessIssue[]> {
  const cycleFiles = (await readdir(input.resultDir))
    .map(file => /^cycle-(\d+)\.json$/.exec(file))
    .filter((match): match is RegExpExecArray => match !== null)
    .map(match => ({ file: match[0], cycle: Number(match[1]) }))
    .sort((left, right) => right.cycle - left.cycle);

  if (cycleFiles.length === 0) {
    throw new Error(`No cycle artifacts found for existing session ${input.args.sessionId}`);
  }

  const latest = JSON.parse(await readFile(join(input.resultDir, cycleFiles[0].file), 'utf-8')) as {
    trackedIssues?: { number: number }[];
  };
  const issueNumbers = latest.trackedIssues?.map(issue => issue.number) ?? [];
  if (issueNumbers.length === 0) {
    throw new Error(`No tracked issues found in ${cycleFiles[0].file}`);
  }

  const issues = await Promise.all(
    issueNumbers.map(issueNumber => input.github.getIssue(input.target.repo, issueNumber))
  );
  const missing = issueNumbers.filter((_, index) => !issues[index]);
  if (missing.length > 0) {
    throw new Error(`Could not load existing issues: ${missing.join(', ')}`);
  }

  return issues.filter((issue): issue is HarnessIssue => issue !== undefined);
}

async function createEcommerceAppIssues(
  github: GitHubGhAdapter,
  args: LiveArgs,
  target: LiveTarget,
  options: { autoMergeAll: boolean }
): Promise<HarnessIssue[]> {
  const issueLabels = (autoMerge: boolean): string[] => [
    TEST_LABEL,
    LIFECYCLE_LABELS.ready,
    SIMPLE_FIX_ROUTING_LABEL,
    ...(autoMerge ? [LIFECYCLE_LABELS.autoMerge] : []),
    'area:test',
  ];
  const prMergeInstruction = options.autoMergeAll
    ? 'Open a PR and allow Archon to merge it automatically after verification.'
    : 'Open a PR but do not auto-merge this issue.';

  const skeleton = await github.createIssue({
    repo: target.repo,
    title: `[archon-test:${args.sessionId}] Ecommerce app skeleton`,
    body: buildEcommerceAppIssueBody({
      args,
      role: 'skeleton',
      summary: 'Create the minimal runnable ecommerce storefront foundation.',
      acceptanceCriteria: [
        'Create a small TypeScript browser app; choose the simplest structure and tooling that fits this empty repo.',
        'Render a storefront shell with a header, product grid or product cards, cart summary placeholder, and checkout placeholder.',
        'Include npm scripts for type-check, lint, format:check, test, and build that can run successfully in this tiny repo.',
        'Keep the implementation focused on the ecommerce app and avoid generated build/dependency output in git.',
      ],
    }),
    labels: issueLabels(true),
  });

  const catalog = await github.createIssue({
    repo: target.repo,
    title: `[archon-test:${args.sessionId}] Ecommerce catalog interactions`,
    body: buildEcommerceAppIssueBody({
      args,
      role: 'catalog',
      summary: 'Add real catalog browsing behavior to the storefront.',
      acceptanceCriteria: [
        'Add category filtering, text search, and price sorting over the product data from the skeleton.',
        'Choose appropriate files and function boundaries based on the skeleton implementation.',
        'Add focused tests for the catalog behavior.',
        'Wire the catalog behavior into the existing storefront UI while minimizing conflicts with cart/checkout work.',
        prMergeInstruction,
      ],
    }),
    labels: issueLabels(options.autoMergeAll),
  });

  const cartCheckout = await github.createIssue({
    repo: target.repo,
    title: `[archon-test:${args.sessionId}] Ecommerce cart and checkout`,
    body: buildEcommerceAppIssueBody({
      args,
      role: 'cart-checkout',
      summary: 'Add cart totals and checkout confirmation behavior to the storefront.',
      acceptanceCriteria: [
        'Add pure cart helpers for add, remove, quantity updates, subtotal, shipping, tax, and total.',
        'Add checkout validation for name, email, and shipping address plus a deterministic order confirmation id.',
        'Choose appropriate files and function boundaries based on the skeleton implementation.',
        'Add focused tests for cart and checkout behavior.',
        'Wire cart and checkout behavior into the existing storefront UI while minimizing conflicts with catalog work.',
        prMergeInstruction,
      ],
    }),
    labels: issueLabels(options.autoMergeAll),
  });

  await github.addIssueBlockedBy(target.repo, catalog.number, skeleton.number);
  await github.addIssueBlockedBy(target.repo, cartCheckout.number, skeleton.number);

  const hydratedCatalog = await github.getIssue(target.repo, catalog.number);
  const hydratedCartCheckout = await github.getIssue(target.repo, cartCheckout.number);

  return [skeleton, hydratedCatalog ?? catalog, hydratedCartCheckout ?? cartCheckout];
}

function buildIssueContent(args: LiveArgs): { title: string; body: string } {
  const artifactPath = `archon-test/${args.sessionId}.md`;
  const header = [
    'This disposable issue was created by the Archon harness E2E runner.',
    '',
    `Session: ${args.sessionId}`,
    `Issue size: ${args.issueSize}`,
    `Expected branch: ${args.branchName}`,
    '',
  ];

  if (args.issueSize === 'tiny') {
    return {
      title: `[archon-test:${args.sessionId}] Tiny smoke issue`,
      body: [
        ...header,
        'Goal: prove the end-to-end loop with the smallest possible repository change.',
        '',
        'Acceptance criteria:',
        `- Create or update exactly one file: \`${artifactPath}\`.`,
        '- Put exactly one short sentence in the file that includes the session id.',
        '- Do not modify source code, package files, lockfiles, CI, or existing documentation.',
        '- Open a draft PR from the requested branch.',
      ].join('\n'),
    };
  }

  return {
    title: `[archon-test:${args.sessionId}] Small smoke issue`,
    body: [
      ...header,
      'Goal: prove the end-to-end loop with a bounded documentation artifact.',
      '',
      'Acceptance criteria:',
      `- Create or update exactly one file: \`${artifactPath}\`.`,
      '- Include a heading, the session id, the UTC timestamp, and a two-line summary.',
      '- Do not modify source code, package files, lockfiles, CI, or existing documentation.',
      '- Open a draft PR from the requested branch.',
    ].join('\n'),
  };
}

function buildSelfMergeIssueBody(input: { args: LiveArgs; role: string }): string {
  const artifactPath = `archon-test/${input.args.sessionId}-ISSUE_NUMBER.md`;
  return [
    'This disposable issue was created by the Archon harness self-merge live E2E runner.',
    '',
    `Session: ${input.args.sessionId}`,
    `Role: ${input.role}`,
    '',
    'Goal: prove autonomous tiny PR review/merge and dependency unblocking.',
    '',
    'Acceptance criteria:',
    `- Create or update exactly one scoped marker file matching \`${artifactPath}\`.`,
    '- Put exactly one short sentence in the file that includes the session id.',
    '- Do not modify source code, package files, lockfiles, CI, or existing documentation.',
    '- Open a PR, run the tiny self-review, and merge only after that review passes.',
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n');
}

function buildVideoRecordingIssueBody(args: LiveArgs): string {
  return [
    'This disposable issue was created by the Archon harness UI video recording live E2E runner.',
    '',
    `Session: ${args.sessionId}`,
    `Expected artifact branch: ${args.branchName}`,
    '',
    'Goal: run a small happy-path UI E2E test against the target application and record it to prove the application is workable.',
    '',
    'UI test description:',
    '- Inspect the repository and identify the simplest runnable user-facing UI.',
    '- Start the application locally using the repo conventions.',
    '- Exercise one short happy path that a real user would recognize as the app working.',
    '- Prefer a path that reaches a meaningful loaded/interactive state rather than only checking that the page renders.',
    '- Record the browser session while performing the flow and produce a final MP4 artifact.',
    '- Add brief pauses after the page loads, after meaningful interactions, and on the final success state so the recording is easy to follow.',
    '- Verify at least one visible outcome that proves the happy path succeeded.',
    '',
    'Acceptance criteria:',
    '- Record the UI test with Playwright video recording, convert it to MP4, and save the MP4 as a scoped archon-test artifact.',
    '- Include a concise summary of the app path tested, commands used, assertion made, and recording location.',
    '- Push the scoped recording artifact branch without opening a PR.',
    '- Comment on this initial issue with the GitHub-hosted raw MP4 link.',
    '- Do not modify source code, package files, lockfiles, CI, or existing documentation.',
  ].join('\n');
}

function buildEcommerceAppIssueBody(input: {
  args: LiveArgs;
  role: string;
  summary: string;
  acceptanceCriteria: string[];
}): string {
  return [
    'This disposable issue was created by the Archon harness ecommerce app live E2E runner.',
    '',
    `Session: ${input.args.sessionId}`,
    `Role: ${input.role}`,
    '',
    `Goal: ${input.summary}`,
    '',
    'Acceptance criteria:',
    ...input.acceptanceCriteria.map(criteria => `- ${criteria}`),
    '',
    'Safety constraints:',
    '- This is a live E2E test issue; keep the implementation intentionally small.',
    '- Do not add external services, auth, payments, persistence, deploy config, or CI changes.',
    '- Let the agent choose the file layout that best fits the current repository state.',
  ].join('\n');
}

async function isScenarioComplete(input: {
  args: LiveArgs;
  github: GitHubGhAdapter;
  store: SqliteOrchestratorStore;
  issues: HarnessIssue[];
  target?: LiveTarget;
}): Promise<boolean> {
  const repo = input.target?.repo ?? input.args.repo;
  if (!repo) throw new Error('Missing live target repo');
  const runs = await input.store.listRuns(repo);
  const issues = await Promise.all(
    input.issues.map(issue => input.github.getIssue(repo, issue.number))
  );

  if (input.args.scenario === 'ecommerce-app') {
    const [skeleton, catalog, cartCheckout] = issues;
    if (!skeleton || !catalog || !cartCheckout) return false;

    const catalogRun = runs.find(run => run.issueNumber === catalog.number);
    const cartRun = runs.find(run => run.issueNumber === cartCheckout.number);

    return (
      skeleton.state === 'closed' &&
      catalogRun?.status === 'pr_open' &&
      cartRun?.status === 'pr_open'
    );
  }

  if (input.args.scenario === 'ecommerce-app-auto-merge') {
    return (
      runs.length >= input.issues.length &&
      input.issues.every(issue =>
        runs.some(run => run.issueNumber === issue.number && run.status === 'done')
      ) &&
      issues.every(issue => issue?.state === 'closed')
    );
  }

  if (input.args.scenario === 'blocked-parallel') {
    return (
      runs.length >= input.issues.length &&
      input.issues.every(issue =>
        runs.some(run => run.issueNumber === issue.number && run.status === 'done')
      )
    );
  }

  if (input.args.scenario === 'single-auto-merge') {
    const [issue] = issues;
    if (!issue) return false;
    return (
      issue.state === 'closed' &&
      runs.some(run => run.issueNumber === issue.number && run.status === 'done')
    );
  }

  if (input.args.scenario === 'single') {
    return runs.some(
      run => run.status === 'pr_open' || run.status === 'ready_for_review' || run.status === 'done'
    );
  }

  if (input.args.scenario === 'video-recording') {
    return runs.some(run => run.status === 'done');
  }

  return false;
}

function parallelScenarioLimit(scenario: LiveScenario): number {
  if (scenario === 'blocked-parallel') return 3;
  if (isEcommerceScenario(scenario)) return 3;
  return 1;
}

function maxNewRunsPerCycle(scenario: LiveScenario): number {
  if (scenario === 'blocked-parallel') return 2;
  if (isEcommerceScenario(scenario)) return 2;
  return 1;
}

function isIssueSize(value: string): value is IssueSize {
  return ISSUE_SIZES.includes(value as IssueSize);
}

function isScenario(value: string): value is LiveScenario {
  return SCENARIOS.includes(value as LiveScenario);
}

function resolveDefaultEnvFile(): string {
  const candidates = [join(process.cwd(), '.env'), join(import.meta.dir, '..', '..', '..', '.env')];
  return candidates.find(candidate => existsSync(candidate)) ?? candidates[0];
}

function resolveConfigRoot(): string {
  const candidates = [process.cwd(), join(import.meta.dir, '..', '..', '..')];
  return (
    candidates.find(candidate => existsSync(join(candidate, '.archon', 'config.yaml'))) ??
    process.cwd()
  );
}

function isEcommerceScenario(scenario: LiveScenario): boolean {
  return scenario === 'ecommerce-app' || scenario === 'ecommerce-app-auto-merge';
}

function isLongRunningLiveScenario(scenario: LiveScenario): boolean {
  return (
    scenario === 'single-auto-merge' ||
    scenario === 'video-recording' ||
    isEcommerceScenario(scenario)
  );
}

async function resolveLiveTarget(args: LiveArgs): Promise<LiveTarget> {
  const config = await loadConfig(resolveConfigRoot());
  const projects = normalizeBacklogProjects(config.backlog?.projects);
  const selected = selectConfiguredProject(projects, args);

  if (selected) {
    return {
      name: selected.name ?? selected.repo,
      repo: selected.repo,
      cwd: selected.cwd,
      codebaseUrl: repoToSshUrl(selected.repo),
    };
  }

  if (args.repo) {
    return {
      name: args.repo,
      repo: args.repo,
      codebaseUrl: repoToSshUrl(args.repo),
    };
  }

  throw new Error(
    'No live E2E project selected. Configure backlog.projects in .archon/config.yaml or pass --project <name> / --repo <owner/name>.'
  );
}

function normalizeBacklogProjects(
  projects: (string | BacklogProjectConfig)[] | undefined
): BacklogProjectConfig[] {
  return (projects ?? []).map(project =>
    typeof project === 'string' ? { repo: project } : project
  );
}

function selectConfiguredProject(
  projects: BacklogProjectConfig[],
  args: LiveArgs
): BacklogProjectConfig | undefined {
  if (args.repo) return projects.find(project => project.repo === args.repo);

  if (args.project) {
    const selected = projects.find(
      project => project.name === args.project || project.repo === args.project
    );
    if (!selected) {
      throw new Error(`No backlog.projects entry matched --project ${args.project}`);
    }
    return selected;
  }

  if (projects.length === 1) return projects[0];
  return undefined;
}

function repoToSshUrl(repo: string): string {
  return `git@github.com:${repo}.git`;
}

function validateEnv(): {
  archonBaseUrl: string;
  archonApiToken?: string;
} {
  return {
    archonBaseUrl: process.env.ARCHON_BASE_URL ?? 'http://localhost:3090',
    archonApiToken: process.env.ARCHON_API_TOKEN,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

await main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
