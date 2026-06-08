/**
 * Tests for the judge-model registry — SUT→judge resolution + self-grading guard.
 * Run with: npx vitest run libs/testing-shell/src/llm/judges/registry.test.ts
 */
import { describe, expect, it } from 'vitest';
import { resolveJudgeModel, isSelfGradingPair } from './registry';

describe('resolveJudgeModel', () => {
  it('judges an Opus SUT with Sonnet (Opus second-opinion)', () => {
    const e = resolveJudgeModel('claude-opus-4-8');
    expect(e.judge).toBe('claude-sonnet-4-6');
    expect(e.secondOpinion).toBe('claude-opus-4-7');
  });

  it('judges a Sonnet SUT same-family with an Opus second opinion', () => {
    const e = resolveJudgeModel('claude-sonnet-4-6');
    expect(e.judge).toBe('claude-sonnet-4-6');
    expect(e.secondOpinion).toBe('claude-opus-4-7');
  });

  it('steps a Haiku SUT up to a Sonnet judge', () => {
    expect(resolveJudgeModel('claude-haiku-4-5-20251001').judge).toBe('claude-sonnet-4-6');
  });

  it('is case-insensitive on the family prefix', () => {
    expect(resolveJudgeModel('CLAUDE-OPUS-4-8').secondOpinion).toBe('claude-opus-4-7');
  });

  it('falls back to a Sonnet judge with no second opinion for an unknown SUT', () => {
    const e = resolveJudgeModel('gpt-4o');
    expect(e.judge).toBe('claude-sonnet-4-6');
    expect(e.secondOpinion).toBeUndefined();
  });
});

describe('isSelfGradingPair', () => {
  it('is true only when SUT and judge are identical', () => {
    expect(isSelfGradingPair('claude-sonnet-4-6', 'claude-sonnet-4-6')).toBe(true);
    expect(isSelfGradingPair('claude-opus-4-8', 'claude-sonnet-4-6')).toBe(false);
  });
});
