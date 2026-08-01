/**
 * Unit tests for computeRunStatus (EI-133).
 *
 * The deterministic asserts are always the load-bearing gate (D-002): an
 * error-severity assert violation fails a run unconditionally. A judge-only
 * error finding fails the run too — UNLESS the scenario's rubric opts into
 * `judgeAdvisory: true`, in which case it is surfaced but does not flip the
 * verdict. Before this fix, `judgeAdvisory` didn't exist and a judge-only
 * error finding always failed the run, which is what let the D-004 hermetic
 * stub executor's known groundedness pathologies flip otherwise-clean su
 * suite runs (all deterministic asserts passing) to `failed`.
 */

import { describe, expect, it } from 'vitest';

import { computeRunStatus } from '../runner';
import type { JudgeFinding, JudgeResult, JudgeRubric, Violation } from '../types';

const RUBRIC: JudgeRubric = { version: '1.0.0', axes: [] };
const ADVISORY_RUBRIC: JudgeRubric = { version: '1.0.0', axes: [], judgeAdvisory: true };

const finding = (over: Partial<JudgeFinding> = {}): JudgeFinding => ({
  axis: 'groundedness',
  severity: 'error',
  shape: 'shape-a',
  claim: 'fabricated a table name',
  ...over,
});

const judge = (findings: JudgeFinding[] = []): JudgeResult => ({
  scores: {},
  findings,
  judgeOverruledAssert: false,
  costUsd: 0,
});

const violation = (over: Partial<Violation> = {}): Violation => ({
  assertKind: 'tool_fired',
  severity: 'error',
  claim: 'expected tool X never fired',
  ...over,
});

describe('computeRunStatus', () => {
  it('passed: no violations, no findings', () => {
    expect(
      computeRunStatus({ finishReason: 'completed', inconclusive: null, violations: [], judge: judge(), rubric: RUBRIC }),
    ).toBe('passed');
  });

  it('errored: finishReason errored, regardless of violations/findings', () => {
    expect(
      computeRunStatus({
        finishReason: 'errored',
        inconclusive: null,
        violations: [],
        judge: judge(),
        rubric: RUBRIC,
      }),
    ).toBe('errored');
  });

  it('errored: inconclusive reason set, even with a clean judge', () => {
    expect(
      computeRunStatus({
        finishReason: 'completed',
        inconclusive: 'all 3 turn(s) produced empty output',
        violations: [],
        judge: judge(),
        rubric: RUBRIC,
      }),
    ).toBe('errored');
  });

  it('failed: an error-severity deterministic assert violation, non-advisory rubric', () => {
    expect(
      computeRunStatus({
        finishReason: 'completed',
        inconclusive: null,
        violations: [violation()],
        judge: judge(),
        rubric: RUBRIC,
      }),
    ).toBe('failed');
  });

  it('failed: an error-severity deterministic assert violation ALSO fails an advisory rubric (D-002 stays load-bearing)', () => {
    expect(
      computeRunStatus({
        finishReason: 'completed',
        inconclusive: null,
        violations: [violation()],
        judge: judge(),
        rubric: ADVISORY_RUBRIC,
      }),
    ).toBe('failed');
  });

  it('failed: a judge-only error finding fails a non-advisory rubric (pre-existing, unchanged behavior)', () => {
    expect(
      computeRunStatus({
        finishReason: 'completed',
        inconclusive: null,
        violations: [],
        judge: judge([finding()]),
        rubric: RUBRIC,
      }),
    ).toBe('failed');
  });

  it('passed: a judge-only error finding does NOT fail an advisory rubric (the EI-133 fix)', () => {
    expect(
      computeRunStatus({
        finishReason: 'completed',
        inconclusive: null,
        violations: [],
        judge: judge([finding()]),
        rubric: ADVISORY_RUBRIC,
      }),
    ).toBe('passed');
  });

  it('passed: a warn/info-severity judge finding never fails a run, advisory or not', () => {
    const warnOnly = judge([finding({ severity: 'warn' }), finding({ severity: 'info' })]);
    expect(
      computeRunStatus({ finishReason: 'completed', inconclusive: null, violations: [], judge: warnOnly, rubric: RUBRIC }),
    ).toBe('passed');
    expect(
      computeRunStatus({
        finishReason: 'completed',
        inconclusive: null,
        violations: [],
        judge: warnOnly,
        rubric: ADVISORY_RUBRIC,
      }),
    ).toBe('passed');
  });

  it('passed: a warn-severity assert violation never fails a run on its own', () => {
    expect(
      computeRunStatus({
        finishReason: 'completed',
        inconclusive: null,
        violations: [violation({ severity: 'warn' })],
        judge: judge(),
        rubric: RUBRIC,
      }),
    ).toBe('passed');
  });
});
