/**
 * Compare/select runner + Scorer modes (test-gym-apiary-framework-2026-06-09
 * P-002 + P-003).
 *
 * Proves:
 *   1. compareArms — direction-aware diffs, ranking, minDelta selection,
 *      unmeasurable/errored arms sink, baseline-errored never selects.
 *   2. runCompareSelect — baseline runs first with NO variant, each candidate
 *      arm gets exactly its own variant, an errored candidate is recorded and
 *      excluded from ranking (run continues), scorers extract from the
 *      reports, the improving candidate gets selected.
 *   3. Loud input validation — duplicate / reserved variant ids, preset
 *      runnerOpts.variant.
 *   4. The built-in scorers (pass-rate, mean-cost, judge-axis) compute what
 *      they claim from synthetic RunReports.
 *
 * Everything is in-memory: a fake runScenarioFn, no targets, no PG, no LLM.
 */

import { describe, expect, it } from 'vitest';

import {
  BASELINE_ID,
  compareArms,
  deterministicScorer,
  judgeAxisScorer,
  meanCostScorer,
  passRateScorer,
  runCompareSelect,
  type CompareArm,
  type Scorer,
} from '../compare-select';
import type { RunReport, SingleRunReport } from '../runner';
import type { RunnerDeps } from '../deps';
import type { JudgeResult, PersonaTraits, RunSummary, Scenario, ScenarioVariant } from '../types';

const TRAITS: PersonaTraits = {
  verbosity: 'terse',
  politeness: 'neutral',
  clarification: 'never_clarifies',
  goalClarity: 'precise',
  interrupts: false,
  modality: 'text',
};

function makeSummary(over: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: 'r1',
    scenarioId: 'cmp-test',
    scenarioVersion: 1,
    identityHash: 'h',
    sutModel: 'claude-sonnet-4-6',
    judgeModel: 'claude-opus-4-8',
    personaId: 'brief-admin',
    personaTraits: TRAITS,
    workspaceMode: 'isolated',
    transportMode: 'in-process',
    turns: [],
    toolInvocations: [],
    continueChainRows: [],
    totalCostUsd: 0,
    startedAt: new Date(),
    finishedAt: new Date(),
    finishReason: 'completed',
    capBreaches: [],
    ...over,
  };
}

function makeJudge(scores: Record<string, number> = {}): JudgeResult {
  return { scores, findings: [], judgeOverruledAssert: false, costUsd: 0 };
}

function makeRun(over: {
  status?: SingleRunReport['status'];
  costUsd?: number;
  judgeScores?: Record<string, number>;
} = {}): SingleRunReport {
  return {
    summary: makeSummary({ totalCostUsd: over.costUsd ?? 0 }),
    violations: [],
    judge: makeJudge(over.judgeScores ?? {}),
    status: over.status ?? 'passed',
  };
}

function makeReport(runs: SingleRunReport[], scenarioId = 'cmp-test'): RunReport {
  return { scenarioId, runs, verdict: 'pass', varianceByAxis: {}, varianceFindings: [] };
}

function arm(variantId: string, metrics: Record<string, number | undefined>, error?: string): CompareArm {
  return { variantId, metrics, ...(error !== undefined && { error }) };
}

const SCORERS: Array<Pick<Scorer, 'id' | 'direction'>> = [
  { id: 'quality', direction: 'higher-better' },
  { id: 'cost', direction: 'lower-better' },
];

describe('compareArms', () => {
  it('diffs direction-aware, ranks best-first, selects a strict improver', () => {
    const result = compareArms({
      baseline: arm(BASELINE_ID, { quality: 3, cost: 1.0 }),
      candidates: [
        arm('weak', { quality: 2.5, cost: 0.9 }),
        arm('strong', { quality: 4.5, cost: 1.2 }),
      ],
      scorers: SCORERS,
      primary: 'quality',
    });

    expect(result.candidates.map((c) => c.variantId)).toEqual(['strong', 'weak']);
    expect(result.candidates[0]!.rank).toBe(1);
    expect(result.candidates[0]!.primaryImprovement).toBe(1.5);
    expect(result.selected).toBe('strong');

    const strongCost = result.candidates[0]!.diffs.find((d) => d.scorerId === 'cost')!;
    expect(strongCost.delta).toBeCloseTo(0.2);
    expect(strongCost.improved).toBe(false); // lower-better, cost went up
    const weakQuality = result.candidates[1]!.diffs.find((d) => d.scorerId === 'quality')!;
    expect(weakQuality.improved).toBe(false);
  });

  it('lower-better primary: improvement is the direction-normalized delta', () => {
    const result = compareArms({
      baseline: arm(BASELINE_ID, { quality: 3, cost: 1.0 }),
      candidates: [arm('cheap', { quality: 3, cost: 0.4 })],
      scorers: SCORERS,
      primary: 'cost',
    });
    expect(result.candidates[0]!.primaryImprovement).toBeCloseTo(0.6);
    expect(result.selected).toBe('cheap');
  });

  it('baseline holds when the best improvement does not exceed minDelta', () => {
    const result = compareArms({
      baseline: arm(BASELINE_ID, { quality: 3 }),
      candidates: [arm('slight', { quality: 3.2 })],
      scorers: [{ id: 'quality', direction: 'higher-better' }],
      primary: 'quality',
      minDelta: 0.5,
    });
    expect(result.selected).toBeUndefined();
    expect(result.selectionReason).toContain('baseline_holds');
  });

  it('a non-improving or unmeasurable top candidate never gets selected', () => {
    const result = compareArms({
      baseline: arm(BASELINE_ID, { quality: 3 }),
      candidates: [arm('worse', { quality: 2 }), arm('unmeasured', {})],
      scorers: [{ id: 'quality', direction: 'higher-better' }],
      primary: 'quality',
    });
    expect(result.selected).toBeUndefined();
    // measurable-but-worse ranks above unmeasurable
    expect(result.candidates.map((c) => c.variantId)).toEqual(['worse', 'unmeasured']);
    expect(result.candidates[1]!.primaryImprovement).toBeUndefined();
  });

  it('errored arms sink and an errored baseline blocks selection entirely', () => {
    const result = compareArms({
      baseline: arm(BASELINE_ID, {}, 'boom'),
      candidates: [arm('fine', { quality: 5 })],
      scorers: [{ id: 'quality', direction: 'higher-better' }],
      primary: 'quality',
    });
    expect(result.selected).toBeUndefined();
    expect(result.selectionReason).toContain('baseline_errored');
  });

  it('throws on a primary that is not among the scorers', () => {
    expect(() =>
      compareArms({
        baseline: arm(BASELINE_ID, {}),
        candidates: [],
        scorers: SCORERS,
        primary: 'nope',
      }),
    ).toThrow(/primary scorer 'nope'/);
  });
});

describe('built-in scorers', () => {
  it('passRateScorer counts passed/total; meanCostScorer averages totalCostUsd', () => {
    const report = makeReport([
      makeRun({ status: 'passed', costUsd: 1 }),
      makeRun({ status: 'failed', costUsd: 3 }),
    ]);
    expect(passRateScorer.score(report)).toBe(0.5);
    expect(meanCostScorer.score(report)).toBe(2);
    expect(passRateScorer.mode).toBe('deterministic');
  });

  it('judgeAxisScorer averages one axis and is undefined when the axis is absent', () => {
    const scorer = judgeAxisScorer('helpfulness');
    const report = makeReport([
      makeRun({ judgeScores: { helpfulness: 4 } }),
      makeRun({ judgeScores: { helpfulness: 2 } }),
    ]);
    expect(scorer.score(report)).toBe(3);
    expect(scorer.mode).toBe('judge');
    expect(scorer.score(makeReport([makeRun()]))).toBeUndefined();
  });

  it('empty report yields undefined, never NaN', () => {
    const empty = makeReport([]);
    expect(passRateScorer.score(empty)).toBeUndefined();
    expect(meanCostScorer.score(empty)).toBeUndefined();
  });
});

describe('runCompareSelect', () => {
  const scenario = { id: 'cmp-scenario' } as unknown as Scenario;
  const deps = {} as RunnerDeps;
  const VARIANTS: ScenarioVariant[] = [
    { id: 'idea-a', promptOverlay: 'be terse' },
    { id: 'idea-b', promptOverlay: 'be thorough' },
  ];
  const quality = judgeAxisScorer('quality');

  it('runs baseline first with no variant, one arm per candidate, and selects the improver', async () => {
    const seen: Array<string | undefined> = [];
    const reportsByVariant: Record<string, RunReport> = {
      [BASELINE_ID]: makeReport([makeRun({ judgeScores: { quality: 3 } })]),
      'idea-a': makeReport([makeRun({ judgeScores: { quality: 2 } })]),
      'idea-b': makeReport([makeRun({ judgeScores: { quality: 5 } })]),
    };
    const result = await runCompareSelect(
      {
        scenario,
        variants: VARIANTS,
        scorers: [quality, passRateScorer],
        primary: 'judge:quality',
        runScenarioFn: async (_s, opts) => {
          seen.push(opts?.variant?.id);
          return reportsByVariant[opts?.variant?.id ?? BASELINE_ID]!;
        },
      },
      deps,
    );

    expect(seen).toEqual([undefined, 'idea-a', 'idea-b']);
    expect(result.scenarioId).toBe('cmp-scenario');
    expect(result.baseline.metrics['judge:quality']).toBe(3);
    expect(result.candidates.map((c) => c.variantId)).toEqual(['idea-b', 'idea-a']);
    expect(result.selected).toBe('idea-b');
  });

  it('records an errored candidate arm and keeps going — baseline holds vs the rest', async () => {
    const result = await runCompareSelect(
      {
        scenario,
        variants: VARIANTS,
        scorers: [quality],
        primary: 'judge:quality',
        runScenarioFn: async (_s, opts) => {
          if (opts?.variant?.id === 'idea-a') throw new Error('target exploded');
          const q = opts?.variant?.id === 'idea-b' ? 2 : 3;
          return makeReport([makeRun({ judgeScores: { quality: q } })]);
        },
      },
      deps,
    );

    const erroredArm = result.candidates.find((c) => c.variantId === 'idea-a')!;
    expect(erroredArm.errored).toBe(true);
    expect(erroredArm.rank).toBe(2); // sinks below the measurable candidate
    expect(result.selected).toBeUndefined();
  });

  it('an errored baseline is recorded and blocks selection', async () => {
    const result = await runCompareSelect(
      {
        scenario,
        variants: [VARIANTS[0]!],
        scorers: [quality],
        primary: 'judge:quality',
        runScenarioFn: async (_s, opts) => {
          if (opts?.variant === undefined) throw new Error('baseline exploded');
          return makeReport([makeRun({ judgeScores: { quality: 5 } })]);
        },
      },
      deps,
    );
    expect(result.baseline.error).toBe('baseline exploded');
    expect(result.selected).toBeUndefined();
    expect(result.selectionReason).toContain('baseline_errored');
  });

  it('rejects empty variants, reserved/duplicate ids, and a preset runnerOpts.variant', async () => {
    const ok = async () => makeReport([makeRun()]);
    await expect(
      runCompareSelect({ scenario, variants: [], scorers: [quality], primary: 'judge:quality', runScenarioFn: ok }, deps),
    ).rejects.toThrow(/no candidate variants/);
    await expect(
      runCompareSelect(
        { scenario, variants: [{ id: BASELINE_ID }], scorers: [quality], primary: 'judge:quality', runScenarioFn: ok },
        deps,
      ),
    ).rejects.toThrow(/reserved/);
    await expect(
      runCompareSelect(
        {
          scenario,
          variants: [{ id: 'x' }, { id: 'x' }],
          scorers: [quality],
          primary: 'judge:quality',
          runScenarioFn: ok,
        },
        deps,
      ),
    ).rejects.toThrow(/duplicate variant id/);
    await expect(
      runCompareSelect(
        {
          scenario,
          variants: [{ id: 'x' }],
          scorers: [quality],
          primary: 'judge:quality',
          runnerOpts: { variant: { id: 'sneaky' } },
          runScenarioFn: ok,
        },
        deps,
      ),
    ).rejects.toThrow(/not runnerOpts.variant/);
  });

  it('custom deterministic collectors plug in via deterministicScorer', async () => {
    const turnCount = deterministicScorer('turns', 'lower-better', (r) =>
      r.runs.length === 0 ? undefined : r.runs.reduce((s, x) => s + x.summary.turns.length, 0) / r.runs.length,
    );
    const result = await runCompareSelect(
      {
        scenario,
        variants: [VARIANTS[0]!],
        scorers: [turnCount],
        primary: 'turns',
        runScenarioFn: async () => makeReport([makeRun()]),
      },
      deps,
    );
    expect(result.baseline.metrics['turns']).toBe(0);
    expect(result.primaryScorer).toBe('turns');
  });
});
