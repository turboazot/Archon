import { mkdir, readFile, readdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { GitHubGhAdapter } from '../src/adapters/github-gh';
import { createDefaultHarnessConfig, HarnessOrchestrator } from '../src/orchestrator';
import { LIFECYCLE_LABELS } from '../src/lifecycle';
import type { HarnessIssue, StatusReport } from '../src/types';
import { ArchonRestAdapter } from './support/archon-rest';
import { SqliteOrchestratorStore } from './support/sqlite-store';

const DEFAULT_REPO = 'podlodka-ai-club/X15';
const RESULTS_ROOT = join(import.meta.dir, 'results');
const E2E_LABEL = 'archon-e2e';
const TINY_ROUTING_LABEL = 'archon-workflow:e2e-tiny';
const SELF_MERGE_ROUTING_LABEL = 'archon-workflow:e2e-tiny-self-merge';
const SIMPLE_FIX_ROUTING_LABEL = 'archon-workflow:fix-issue-simple';
const ISSUE_SIZES = ['tiny', 'small'] as const;
const SCENARIOS = ['single', 'blocked-parallel', 'ecommerce-app'] as const;

type IssueSize = (typeof ISSUE_SIZES)[number];
type LiveScenario = (typeof SCENARIOS)[number];

interface LiveArgs {
  cycles: number;
  repo: string;
  delayMs: number;
  sessionId: string;
  issueSize: IssueSize;
  branchName?: string;
  envFile: string;
  preflightOnly: boolean;
  resumeExisting: boolean;
  scenario: LiveScenario;
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  await loadEnvFile(args.envFile);
  const env = validateEnv();
  const resultDir = join(RESULTS_ROOT, args.sessionId);
  await mkdir(resultDir, { recursive: true });

  const github = new GitHubGhAdapter({ allowMerge: env.allowMerge });
  const archon = new ArchonRestAdapter({
    baseUrl: env.archonBaseUrl,
    codebaseUrl: env.archonCodebaseUrl,
    token: env.archonApiToken,
    sessionId: args.sessionId,
    branchName: args.branchName,
  });
  const store = new SqliteOrchestratorStore(join(resultDir, 'orchestrator.sqlite'));

  try {
    await archon.checkHealth();
    await github.listIssues(args.repo);
    if (args.preflightOnly) {
      console.log('Live E2E preflight passed');
      console.log(`Repo: ${args.repo}`);
      console.log(`Archon: ${env.archonBaseUrl}`);
      console.log(`Branch: ${args.branchName ?? 'per issue'}`);
      console.log(`Issue size: ${args.issueSize}`);
      console.log(`Scenario: ${args.scenario}`);
      console.log(`Resume existing: ${args.resumeExisting ? 'yes' : 'no'}`);
      return;
    }

    await ensureHarnessLabels(github, args.repo);
    const issues = args.resumeExisting
      ? await loadExistingScenarioIssues({ github, args, resultDir })
      : await createScenarioIssues(github, args);

    const orchestrator = new HarnessOrchestrator(
      createDefaultHarnessConfig({
        repo: args.repo,
        autoMergeEnabled: env.allowMerge,
        maxParallelWorkflows: parallelScenarioLimit(args.scenario),
        maxOpenAgentPrs: parallelScenarioLimit(args.scenario),
        maxNewRunsPerCycle: maxNewRunsPerCycle(args.scenario),
        areaLockPolicy: args.scenario === 'single' ? 'conservative' : 'none',
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
        repo: args.repo,
        issueNumbers: issues.map(issue => issue.number),
        github,
        store,
      });
      if (await isScenarioComplete({ args, github, store, issues })) {
        completedEarly = true;
        console.log(`Scenario ${args.scenario} reached completion condition at cycle ${cycle}`);
        break;
      }
      if (cycle < args.cycles) await sleep(args.delayMs);
    }

    const finalState = {
      issues: await github.listIssues(args.repo),
      pullRequests: await github.listPullRequests(args.repo),
      runs: await store.listRuns(args.repo),
    };

    await writeFile(
      join(resultDir, 'result.json'),
      JSON.stringify(
        {
          sessionId: args.sessionId,
          repo: args.repo,
          scenario: args.scenario,
          issueSize: args.issueSize,
          branchName: args.branchName ?? null,
          issues,
          reports,
          completedEarly,
          finalState,
          safety: {
            liveGate: 'ARCHON_E2E_LIVE=1',
            markerLabel: E2E_LABEL,
            branchName: args.branchName ?? null,
            allowMerge: env.allowMerge,
          },
        },
        null,
        2
      )
    );

    console.log(`Live E2E session ${args.sessionId} finished`);
    console.log(`Issues: ${issues.map(issue => `#${String(issue.number)}`).join(', ')}`);
    console.log(`Artifacts: ${resultDir}`);
  } finally {
    store.close();
  }
}

async function ensureHarnessLabels(github: GitHubGhAdapter, repo: string): Promise<void> {
  const labels = [
    E2E_LABEL,
    ...Object.values(LIFECYCLE_LABELS),
    TINY_ROUTING_LABEL,
    SELF_MERGE_ROUTING_LABEL,
    SIMPLE_FIX_ROUTING_LABEL,
    'area:e2e',
  ];
  for (const label of labels) {
    await github.ensureLabel(repo, label, label === E2E_LABEL ? 'd4c5f9' : '5319e7');
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
  let repo = DEFAULT_REPO;
  let delayMs = 10_000;
  let sessionId = new Date().toISOString().replace(/[:.]/g, '-');
  let issueSize: IssueSize = 'tiny';
  let envFile = join(process.cwd(), '.env');
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

  const resolvedCycles = cycles ?? (scenario === 'ecommerce-app' ? 120 : 3);
  if (!Number.isInteger(resolvedCycles) || resolvedCycles < 1 || resolvedCycles > 240) {
    throw new Error('--cycles must be an integer from 1 to 240');
  }
  if (!Number.isInteger(delayMs) || delayMs < 0) {
    throw new Error('--delay-ms must be a non-negative integer');
  }
  if (!repo.includes('/')) throw new Error('--repo must be owner/name');
  if (resumeExisting && !argv.includes('--session')) {
    throw new Error('--resume-existing requires --session <existing-session-id>');
  }
  return {
    cycles: resolvedCycles,
    repo,
    delayMs,
    sessionId,
    issueSize,
    branchName: scenario === 'single' ? `archon-e2e/${sessionId}` : undefined,
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
    process.stderr.write(`[archon-e2e] loaded ${String(loaded)} keys from ${path}\n`);
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
  args: LiveArgs
): Promise<HarnessIssue[]> {
  if (args.scenario === 'single') {
    const issueContent = buildIssueContent(args);
    const issue = await github.createIssue({
      repo: args.repo,
      title: issueContent.title,
      body: issueContent.body,
      labels: [E2E_LABEL, LIFECYCLE_LABELS.ready, TINY_ROUTING_LABEL, 'area:e2e'],
    });
    return [issue];
  }

  if (args.scenario === 'ecommerce-app') {
    return createEcommerceAppIssues(github, args);
  }

  const skeleton = await github.createIssue({
    repo: args.repo,
    title: `[archon-e2e:${args.sessionId}] Skeleton smoke issue`,
    body: buildSelfMergeIssueBody({
      args,
      role: 'skeleton',
    }),
    labels: [
      E2E_LABEL,
      LIFECYCLE_LABELS.ready,
      SELF_MERGE_ROUTING_LABEL,
      LIFECYCLE_LABELS.autoMerge,
      'area:e2e',
    ],
  });

  const firstBlocked = await github.createIssue({
    repo: args.repo,
    title: `[archon-e2e:${args.sessionId}] Blocked parallel smoke A`,
    body: buildSelfMergeIssueBody({
      args,
      role: 'parallel-a',
    }),
    labels: [
      E2E_LABEL,
      LIFECYCLE_LABELS.ready,
      SELF_MERGE_ROUTING_LABEL,
      LIFECYCLE_LABELS.autoMerge,
      'area:e2e',
    ],
  });

  const secondBlocked = await github.createIssue({
    repo: args.repo,
    title: `[archon-e2e:${args.sessionId}] Blocked parallel smoke B`,
    body: buildSelfMergeIssueBody({
      args,
      role: 'parallel-b',
    }),
    labels: [
      E2E_LABEL,
      LIFECYCLE_LABELS.ready,
      SELF_MERGE_ROUTING_LABEL,
      LIFECYCLE_LABELS.autoMerge,
      'area:e2e',
    ],
  });

  await github.addIssueBlockedBy(args.repo, firstBlocked.number, skeleton.number);
  await github.addIssueBlockedBy(args.repo, secondBlocked.number, skeleton.number);

  const hydratedFirstBlocked = await github.getIssue(args.repo, firstBlocked.number);
  const hydratedSecondBlocked = await github.getIssue(args.repo, secondBlocked.number);

  return [skeleton, hydratedFirstBlocked ?? firstBlocked, hydratedSecondBlocked ?? secondBlocked];
}

async function loadExistingScenarioIssues(input: {
  github: GitHubGhAdapter;
  args: LiveArgs;
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
    issueNumbers.map(issueNumber => input.github.getIssue(input.args.repo, issueNumber))
  );
  const missing = issueNumbers.filter((_, index) => !issues[index]);
  if (missing.length > 0) {
    throw new Error(`Could not load existing issues: ${missing.join(', ')}`);
  }

  return issues.filter((issue): issue is HarnessIssue => issue !== undefined);
}

async function createEcommerceAppIssues(
  github: GitHubGhAdapter,
  args: LiveArgs
): Promise<HarnessIssue[]> {
  const skeleton = await github.createIssue({
    repo: args.repo,
    title: `[archon-e2e:${args.sessionId}] Ecommerce app skeleton`,
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
    labels: [
      E2E_LABEL,
      LIFECYCLE_LABELS.ready,
      SIMPLE_FIX_ROUTING_LABEL,
      LIFECYCLE_LABELS.autoMerge,
      'area:e2e',
    ],
  });

  const catalog = await github.createIssue({
    repo: args.repo,
    title: `[archon-e2e:${args.sessionId}] Ecommerce catalog interactions`,
    body: buildEcommerceAppIssueBody({
      args,
      role: 'catalog',
      summary: 'Add real catalog browsing behavior to the storefront.',
      acceptanceCriteria: [
        'Add category filtering, text search, and price sorting over the product data from the skeleton.',
        'Choose appropriate files and function boundaries based on the skeleton implementation.',
        'Add focused tests for the catalog behavior.',
        'Wire the catalog behavior into the existing storefront UI while minimizing conflicts with cart/checkout work.',
        'Open a PR but do not auto-merge this issue.',
      ],
    }),
    labels: [E2E_LABEL, LIFECYCLE_LABELS.ready, SIMPLE_FIX_ROUTING_LABEL, 'area:e2e'],
  });

  const cartCheckout = await github.createIssue({
    repo: args.repo,
    title: `[archon-e2e:${args.sessionId}] Ecommerce cart and checkout`,
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
        'Open a PR but do not auto-merge this issue.',
      ],
    }),
    labels: [E2E_LABEL, LIFECYCLE_LABELS.ready, SIMPLE_FIX_ROUTING_LABEL, 'area:e2e'],
  });

  await github.addIssueBlockedBy(args.repo, catalog.number, skeleton.number);
  await github.addIssueBlockedBy(args.repo, cartCheckout.number, skeleton.number);

  const hydratedCatalog = await github.getIssue(args.repo, catalog.number);
  const hydratedCartCheckout = await github.getIssue(args.repo, cartCheckout.number);

  return [skeleton, hydratedCatalog ?? catalog, hydratedCartCheckout ?? cartCheckout];
}

function buildIssueContent(args: LiveArgs): { title: string; body: string } {
  const artifactPath = `archon-e2e/${args.sessionId}.md`;
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
      title: `[archon-e2e:${args.sessionId}] Tiny smoke issue`,
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
    title: `[archon-e2e:${args.sessionId}] Small smoke issue`,
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
  const artifactPath = `archon-e2e/${input.args.sessionId}-ISSUE_NUMBER.md`;
  return [
    'This disposable issue was created by the Archon harness blocked-parallel live E2E runner.',
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
}): Promise<boolean> {
  const runs = await input.store.listRuns(input.args.repo);
  const issues = await Promise.all(
    input.issues.map(issue => input.github.getIssue(input.args.repo, issue.number))
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

  if (input.args.scenario === 'blocked-parallel') {
    return (
      runs.length >= input.issues.length &&
      input.issues.every(issue =>
        runs.some(run => run.issueNumber === issue.number && run.status === 'done')
      )
    );
  }

  if (input.args.scenario === 'single') {
    return runs.some(
      run => run.status === 'pr_open' || run.status === 'ready_for_review' || run.status === 'done'
    );
  }

  return false;
}

function parallelScenarioLimit(scenario: LiveScenario): number {
  if (scenario === 'blocked-parallel') return 3;
  if (scenario === 'ecommerce-app') return 3;
  return 1;
}

function maxNewRunsPerCycle(scenario: LiveScenario): number {
  if (scenario === 'blocked-parallel') return 2;
  if (scenario === 'ecommerce-app') return 2;
  return 1;
}

function isIssueSize(value: string): value is IssueSize {
  return ISSUE_SIZES.includes(value as IssueSize);
}

function isScenario(value: string): value is LiveScenario {
  return SCENARIOS.includes(value as LiveScenario);
}

function validateEnv(): {
  archonBaseUrl: string;
  archonCodebaseUrl: string;
  archonApiToken?: string;
  allowMerge: boolean;
} {
  if (process.env.ARCHON_E2E_LIVE !== '1') {
    throw new Error('Refusing live run without ARCHON_E2E_LIVE=1');
  }
  const archonBaseUrl = requireEnv('ARCHON_BASE_URL');
  const archonCodebaseUrl =
    process.env.ARCHON_CODEBASE_URL ?? 'git@github.com:podlodka-ai-club/X15.git';
  return {
    archonBaseUrl,
    archonCodebaseUrl,
    archonApiToken: process.env.ARCHON_API_TOKEN,
    allowMerge: process.env.ARCHON_E2E_ALLOW_MERGE === '1',
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

await main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
