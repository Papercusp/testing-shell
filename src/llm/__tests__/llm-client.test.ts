/**
 * Tests for the framework's Anthropic-SDK wrapper resilience helpers:
 *  - isTemperatureDeprecatedError — drives the retry-without-temperature
 *    self-heal in llmCall (a model that newly rejects `temperature`).
 *  - tryParseJson — recovers JSON from fenced or prose-wrapped output
 *    so the judge/sim-user don't fail on a cosmetically-wrapped reply.
 */

import { describe, it, expect } from 'vitest';

import { estimateCost, isTemperatureDeprecatedError, tryParseJson } from '../llm-client';

describe('isTemperatureDeprecatedError', () => {
  it('matches the literal Anthropic 400 message', () => {
    const err = new Error(
      '400 {"type":"error","error":{"type":"invalid_request_error",' +
        '"message":"`temperature` is deprecated for this model."}}',
    );
    expect(isTemperatureDeprecatedError(err)).toBe(true);
  });

  it('matches "not supported" phrasing', () => {
    expect(
      isTemperatureDeprecatedError(new Error('temperature is not supported by this model')),
    ).toBe(true);
  });

  it('matches "no longer" phrasing', () => {
    expect(
      isTemperatureDeprecatedError(new Error('the temperature parameter is no longer accepted')),
    ).toBe(true);
  });

  it('does not match an overloaded error', () => {
    expect(
      isTemperatureDeprecatedError(
        new Error('529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'),
      ),
    ).toBe(false);
  });

  it('does not match an unrelated rate-limit error', () => {
    expect(isTemperatureDeprecatedError(new Error('429 rate limit exceeded'))).toBe(false);
  });

  it('does not false-match prose that merely mentions temperature', () => {
    expect(isTemperatureDeprecatedError(new Error('the weather temperature today is mild'))).toBe(
      false,
    );
  });

  it('handles non-Error values', () => {
    expect(isTemperatureDeprecatedError('temperature deprecated')).toBe(true);
    expect(isTemperatureDeprecatedError(null)).toBe(false);
    expect(isTemperatureDeprecatedError(undefined)).toBe(false);
  });
});

describe('estimateCost', () => {
  it('prices claude-opus-4-8 (the frozen gym judge model) — must not silently fall to $0', () => {
    // 1M in + 1M out at $15/$75 per 1M = $90. A missing price entry would
    // return 0 and quietly break the gym's deterministic cost guardrail.
    expect(estimateCost('claude-opus-4-8', 1_000_000, 1_000_000)).toBeCloseTo(90, 5);
  });

  it('still prices the existing models', () => {
    expect(estimateCost('claude-sonnet-4-6', 1_000_000, 0)).toBeCloseTo(3, 5);
  });
});

describe('tryParseJson', () => {
  it('parses bare JSON', () => {
    expect(tryParseJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses ```json fenced JSON', () => {
    expect(tryParseJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('parses bare ``` fenced JSON', () => {
    expect(tryParseJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('recovers JSON wrapped in leading prose', () => {
    expect(tryParseJson('Here is the JSON you asked for: {"a":1}')).toEqual({ a: 1 });
  });

  it('recovers JSON with trailing prose', () => {
    expect(tryParseJson('{"a":1}\n\nHope that helps!')).toEqual({ a: 1 });
  });

  it('recovers a nested object from surrounding prose', () => {
    expect(tryParseJson('result:\n{"scores":{"x":3},"findings":[]}\ndone')).toEqual({
      scores: { x: 3 },
      findings: [],
    });
  });

  it('returns null for non-JSON', () => {
    expect(tryParseJson('no json here at all')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(tryParseJson('')).toBeNull();
  });

  it('returns null when the brace-span is not valid JSON', () => {
    expect(tryParseJson('prefix {not: valid json} suffix')).toBeNull();
  });
});
