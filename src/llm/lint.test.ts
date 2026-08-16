/**
 * Tests for the static scenario linter — the guard that catches LLM-scenario
 * authoring drift the type system can't. Run with:
 *   npx vitest run libs/testing-shell/src/llm/lint.test.ts
 */
import { describe, expect, it } from 'vitest';
import { lintScenario, lintScenarios, formatViolations, type LintViolation } from './lint';
import type { Scenario } from './types';

const validScenario = (over: Partial<Scenario> = {}): Scenario =>
  ({
    id: 'S01',
    version: 1,
    target: 'su',
    description: 'a substantive description well over the twenty character minimum',
    caps: { maxTurns: 5, maxWallSecs: 60, maxCostUsd: 1 },
    goal: { kind: 'user_satisfied' },
    persona: { verbosity: 'normal', politeness: 'neutral', clarification: 'sometimes', goalClarity: 'precise', interrupts: false, modality: 'text' },
    rubric: { version: '1.0.0', axes: [{ id: 'helpfulness', anchors: { bad: 'unhelpful', ideal: 'helpful' } }] },
    asserts: [{ kind: 'tool_called', name: 'docs:get' }],
    ...over,
  }) as unknown as Scenario;

const errorFields = (vs: LintViolation[]): string[] =>
  vs.filter((v) => v.severity === 'error').map((v) => v.field);

describe('lintScenario — happy path', () => {
  it('returns no errors for a valid scenario', () => {
    expect(errorFields(lintScenario(validScenario()))).toEqual([]);
  });
});

describe('lintScenario — required fields', () => {
  it('flags a missing/blank id', () => {
    expect(errorFields(lintScenario(validScenario({ id: '' })))).toContain('id');
  });
  it('flags a non-positive-integer version', () => {
    expect(errorFields(lintScenario(validScenario({ version: 0 as never })))).toContain('version');
  });
  it('flags a missing target', () => {
    expect(errorFields(lintScenario(validScenario({ target: '' })))).toContain('target');
  });
  it('flags invalid caps values', () => {
    const vs = lintScenario(validScenario({ caps: { maxTurns: 0, maxWallSecs: -1, maxCostUsd: NaN } as never }));
    expect(errorFields(vs)).toEqual(expect.arrayContaining(['caps.maxTurns', 'caps.maxWallSecs', 'caps.maxCostUsd']));
  });
  it('flags an unknown goal kind', () => {
    expect(errorFields(lintScenario(validScenario({ goal: { kind: 'nope' } as never })))).toContain('goal.kind');
  });
});

describe('lintScenario — target registration', () => {
  it('errors when target is not in registeredTargets', () => {
    const vs = lintScenario(validScenario({ target: 'ghost' }), { registeredTargets: ['su', 'operator'] });
    expect(errorFields(vs)).toContain('target');
  });
  it('passes when target is registered', () => {
    const vs = lintScenario(validScenario({ target: 'su' }), { registeredTargets: ['su'] });
    expect(errorFields(vs)).not.toContain('target');
  });
});

describe('lintScenario — persona', () => {
  it('errors on an unknown blend name', () => {
    expect(errorFields(lintScenario(validScenario({ persona: 'definitely-not-a-blend' as never })))).toContain('persona');
  });
  it('errors on an invalid inline trait value', () => {
    const vs = lintScenario(validScenario({ persona: { verbosity: 'screaming', politeness: 'neutral', clarification: 'sometimes', goalClarity: 'precise', interrupts: false, modality: 'text' } as never }));
    expect(errorFields(vs)).toContain('persona.traits.verbosity');
  });
});

describe('lintScenario — asserts', () => {
  it('errors on an unknown assert kind', () => {
    expect(errorFields(lintScenario(validScenario({ asserts: [{ kind: 'tool_levitated' }] as never })))).toContain('asserts[0].kind');
  });
  it('errors when tool_called lacks a name', () => {
    expect(errorFields(lintScenario(validScenario({ asserts: [{ kind: 'tool_called' }] as never })))).toContain('asserts[0].name');
  });
  it('errors on an invalid finish_reason_is expected value', () => {
    expect(errorFields(lintScenario(validScenario({ asserts: [{ kind: 'finish_reason_is', expected: 'exploded' }] as never })))).toContain('asserts[0].expected');
  });
});

describe('lintScenario — scripted trigger reachability', () => {
  it('errors when an after_turn param is >= caps.maxTurns (unreachable)', () => {
    const vs = lintScenario(validScenario({
      caps: { maxTurns: 3, maxWallSecs: 60, maxCostUsd: 1 } as never,
      triggers: [{ on: 'after_turn', fire: 'continue', param: 3 }] as never,
    }));
    expect(errorFields(vs)).toContain('triggers[0].param');
  });

  it('accepts non-empty scripted user text for user_message triggers', () => {
    const vs = lintScenario(validScenario({
      triggers: [{ on: 'after_turn', fire: 'user_message', param: 1, text: 'what changed?' }],
    }));
    expect(errorFields(vs)).not.toContain('triggers[0].text');
  });

  it('rejects scripted text for non-user-message triggers', () => {
    const vs = lintScenario(validScenario({
      triggers: [{ on: 'after_turn', fire: 'continue', param: 1, text: 'what changed?' }],
    } as never));
    expect(errorFields(vs)).toContain('triggers[0].text');
  });

  it('rejects blank scripted trigger text', () => {
    const vs = lintScenario(validScenario({
      triggers: [{ on: 'after_turn', fire: 'user_message', param: 1, text: '   ' }],
    } as never));
    expect(errorFields(vs)).toContain('triggers[0].text');
  });
});

describe('lintScenario — fixtures', () => {
  it('errors when a declared SSE tape does not exist on disk', () => {
    const vs = lintScenario(
      validScenario({ fixtures: { sseTapePath: 'tapes/missing.jsonl' } as never }),
      { fileExists: () => false, fixtureRoot: '/repo' },
    );
    expect(errorFields(vs)).toContain('fixtures.sseTapePath');
  });
});

describe('lintScenarios', () => {
  it('flags duplicate scenario ids across the registry', () => {
    const vs = lintScenarios([validScenario({ id: 'DUP' }), validScenario({ id: 'DUP' })]);
    expect(vs.some((v) => v.field === 'id' && /duplicate/.test(v.message))).toBe(true);
  });
});

describe('formatViolations', () => {
  it('reports clean when there are no violations', () => {
    expect(formatViolations([])).toMatch(/lint clean/);
  });

  it('groups by scenario, orders errors before warnings, and tallies counts', () => {
    const out = formatViolations([
      { scenarioId: 'S1', field: 'description', severity: 'warn', message: 'too short' },
      { scenarioId: 'S1', field: 'id', severity: 'error', message: 'bad' },
    ]);
    expect(out).toContain('S1:');
    expect(out.indexOf('id:')).toBeLessThan(out.indexOf('description:')); // error first
    expect(out).toContain('1 error(s), 1 warning(s).');
  });
});
