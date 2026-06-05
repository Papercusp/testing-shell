/**
 * Identity hash — composite fingerprint that determines run comparability.
 *
 * Runs with the same identity_hash are directly comparable (e.g. two
 * nightly runs of S01-status-quick over different commits). Changing
 * the scenario, persona traits, rubric version, SUT model, or judge
 * model produces a new identity → a new trend line.
 *
 * Plan §7.1 / §10.
 */

import { createHash } from 'node:crypto';

import type { PersonaTraits, Scenario } from './types';

export function computeIdentityHash(input: {
  scenarioId: string;
  scenarioVersion: number;
  scenarioHash: string;
  personaId: string;
  personaTraits: PersonaTraits;
  rubricVersion: string;
  sutModel: string;
  judgeModel: string;
}): string {
  const canonical = JSON.stringify({
    s: input.scenarioId,
    sv: input.scenarioVersion,
    sh: input.scenarioHash,
    p: input.personaId,
    pt: input.personaTraits,
    rv: input.rubricVersion,
    sm: input.sutModel,
    jm: input.judgeModel,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function computeScenarioHash(scenarioFileContents: string): string {
  return createHash('sha256').update(scenarioFileContents).digest('hex');
}

/** Compute the finding `shape` (§6.6) for novel-failure grouping. */
export function computeFindingShape(axis: string, summary: string): string {
  const normalized = summary
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha256').update(`${axis}::${normalized}`).digest('hex');
}

/**
 * Tighter helper — given a Scenario reference + the runtime metadata, return
 * the identity hash. Pulls `scenarioHash` from the runner's file-reader.
 */
export function identityFor(
  scenario: Pick<Scenario, 'id' | 'version'>,
  scenarioHash: string,
  personaId: string,
  personaTraits: PersonaTraits,
  rubricVersion: string,
  sutModel: string,
  judgeModel: string,
): string {
  return computeIdentityHash({
    scenarioId: scenario.id,
    scenarioVersion: scenario.version,
    scenarioHash,
    personaId,
    personaTraits,
    rubricVersion,
    sutModel,
    judgeModel,
  });
}
