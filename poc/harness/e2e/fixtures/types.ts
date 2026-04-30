import type { HarnessIssue, HarnessPullRequest, StatusReport } from '../../src/types';
import type { InMemoryArchon, InMemoryGitHub, InMemoryOrchestratorStore } from '../../src/mocks';

export interface FixtureContext {
  github: InMemoryGitHub;
  archon: InMemoryArchon;
  store: InMemoryOrchestratorStore;
}

export interface FixtureAction {
  description: string;
  run(context: FixtureContext): Promise<void> | void;
}

export interface FixtureExpectation {
  description: string;
  assert(context: FixtureContext, reports: StatusReport[]): Promise<void> | void;
}

export interface HarnessE2EFixture {
  name: string;
  cycles: number;
  issues: HarnessIssue[];
  pullRequests?: HarnessPullRequest[];
  actionsAfterCycle?: Record<number, FixtureAction[]>;
  expectations: FixtureExpectation[];
}
