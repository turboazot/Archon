import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { createDefaultHarnessConfig, HarnessOrchestrator } from '../src/orchestrator';
import { InMemoryArchon, InMemoryGitHub, InMemoryOrchestratorStore } from '../src/mocks';
import { getFixture, listFixtureNames } from './fixtures';
import type { FixtureContext } from './fixtures/types';
import type { StatusReport } from '../src/types';

const RESULTS_ROOT = join(import.meta.dir, 'results');
const REPO = 'owner/harness';

async function main(): Promise<void> {
  const fixtureName = Bun.argv[2];
  if (!fixtureName || fixtureName === '--help' || fixtureName === '-h') {
    console.log('Usage: bun ./packages/backlog-orchestrator/e2e/run-fixture.ts <fixture>');
    console.log(`Available fixtures: ${listFixtureNames().join(', ')}`);
    return;
  }

  const fixture = getFixture(fixtureName);
  const sessionId = `${fixture.name}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const resultDir = join(RESULTS_ROOT, sessionId);
  await mkdir(resultDir, { recursive: true });

  const github = new InMemoryGitHub({
    issues: fixture.issues,
    pullRequests: fixture.pullRequests,
  });
  const archon = new InMemoryArchon();
  const store = new InMemoryOrchestratorStore();
  const context: FixtureContext = { github, archon, store };
  const orchestrator = new HarnessOrchestrator(createDefaultHarnessConfig({ repo: REPO }), {
    github,
    archon,
    store,
  });

  const reports: StatusReport[] = [];
  const actionLog: { cycle: number; description: string }[] = [];

  for (let cycle = 1; cycle <= fixture.cycles; cycle += 1) {
    const report = await orchestrator.reconcileOnce();
    reports.push(report);

    for (const action of fixture.actionsAfterCycle?.[cycle] ?? []) {
      await action.run(context);
      actionLog.push({ cycle, description: action.description });
    }
  }

  for (const expectation of fixture.expectations) {
    await expectation.assert(context, reports);
  }

  const artifact = {
    fixture: fixture.name,
    sessionId,
    actionLog,
    reports,
    finalState: {
      issues: await github.listIssues(REPO),
      pullRequests: await github.listPullRequests(REPO),
      comments: github.getComments(),
      archonRuns: archon.getStartedRuns(),
      storeRuns: await store.listRuns(REPO),
    },
  };

  await writeFile(join(resultDir, 'result.json'), JSON.stringify(artifact, null, 2));
  console.log(`Fixture ${fixture.name} passed`);
  console.log(`Artifacts: ${resultDir}`);
}

await main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
