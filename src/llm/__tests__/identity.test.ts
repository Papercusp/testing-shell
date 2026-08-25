/**
 * Unit tests for the identity-hash composition rule.
 *
 * Plan §7.1: same scenario file + same persona + same rubric_version +
 * same SUT model + same judge model = same identity_hash. Any of those
 * change → different identity_hash → different trend line.
 */

import { describe, expect, it } from 'vitest';

import { computeIdentityHash, computeScenarioHash, computeFindingShape } from '../identity';
import type { PersonaTraits } from '../types';

const TRAITS: PersonaTraits = {
  verbosity: 'terse',
  politeness: 'neutral',
  clarification: 'never_clarifies',
  goalClarity: 'precise',
  interrupts: false,
  modality: 'text',
};

const BASE = {
  scenarioId: 'op-S01-status-quick',
  scenarioVersion: 1,
  scenarioHash: 'sha-of-file',
  personaId: 'brief-admin',
  personaTraits: TRAITS,
  rubricVersion: '1.0.0',
  sutModel: 'claude-sonnet-4-6',
  judgeModel: 'claude-sonnet-4-6',
  judgeScaffoldVersion: 'abcdef012345',
};

describe('computeIdentityHash', () => {
  it('is deterministic across calls', () => {
    expect(computeIdentityHash(BASE)).toBe(computeIdentityHash(BASE));
  });

  it.each([
    ['scenarioId',      { scenarioId: 'op-S02-multistep-investigation' }],
    ['scenarioVersion', { scenarioVersion: 2 }],
    ['scenarioHash',    { scenarioHash: 'different' }],
    ['personaId',       { personaId: 'patient-admin' }],
    ['rubricVersion',   { rubricVersion: '1.0.1' }],
    ['sutModel',        { sutModel: 'claude-opus-4-7' }],
    ['judgeModel',      { judgeModel: 'claude-opus-4-7' }],
    // WI-41685 / D-013: the judge prompt's own static scaffolding is an input.
    // Before this, editing a rule line or the output schema in judge.ts changed
    // every judged prompt while leaving runs comparable under an unchanged
    // identity — a trend line that looked continuous across a real prompt change.
    ['judgeScaffoldVersion', { judgeScaffoldVersion: '0123456789ab' }],
  ])('changes identity when %s changes', (_label, override) => {
    expect(computeIdentityHash({ ...BASE, ...override })).not.toBe(computeIdentityHash(BASE));
  });

  it('changes identity when any persona trait changes', () => {
    const traitsB: PersonaTraits = { ...TRAITS, verbosity: 'verbose' };
    expect(computeIdentityHash({ ...BASE, personaTraits: traitsB })).not.toBe(computeIdentityHash(BASE));
  });
});

describe('computeScenarioHash', () => {
  it('hashes same content to same hash', () => {
    expect(computeScenarioHash('export const X = 1;')).toBe(computeScenarioHash('export const X = 1;'));
  });
  it('hashes different content differently', () => {
    expect(computeScenarioHash('a')).not.toBe(computeScenarioHash('b'));
  });
});

describe('computeFindingShape', () => {
  it('normalises whitespace and punctuation', () => {
    const a = computeFindingShape('helpfulness', 'Assistant did not call harness:status!');
    const b = computeFindingShape('helpfulness', 'assistant did not call harness status');
    expect(a).toBe(b);
  });
  it('keeps axis distinct', () => {
    expect(computeFindingShape('helpfulness', 'foo')).not.toBe(computeFindingShape('tone', 'foo'));
  });
});
