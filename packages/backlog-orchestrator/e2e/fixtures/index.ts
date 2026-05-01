import { prValidationFailsThenFixFixture } from './pr-validation-fails-then-fix';
import { readySuccessFixture } from './ready-success';
import type { HarnessE2EFixture } from './types';

const fixtures = new Map<string, HarnessE2EFixture>(
  [readySuccessFixture, prValidationFailsThenFixFixture].map(fixture => [fixture.name, fixture])
);

export function getFixture(name: string): HarnessE2EFixture {
  const fixture = fixtures.get(name);
  if (!fixture) {
    throw new Error(
      `Unknown fixture "${name}". Available fixtures: ${[...fixtures.keys()].join(', ')}`
    );
  }
  return fixture;
}

export function listFixtureNames(): string[] {
  return [...fixtures.keys()];
}
