/**
 * Tests for the typed LLM-call error + rate-limit classifier.
 * Run with: npx vitest run libs/testing-shell/src/llm/llm-error.test.ts
 */
import { describe, expect, it } from 'vitest';
import { LlmCallError, isLlmCallError, rateLimitInfo, type TurnError } from './llm-error';

const turn = (over: Partial<TurnError> = {}): TurnError => ({
  class: 'permanent',
  message: 'boom',
  ...over,
});

describe('LlmCallError', () => {
  it('carries the classified turn and uses its message', () => {
    const err = new LlmCallError(turn({ class: 'rate_limited', message: 'slow down' }));
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('LlmCallError');
    expect(err.message).toBe('slow down');
    expect(err.turn.class).toBe('rate_limited');
  });
});

describe('isLlmCallError', () => {
  it('is true only for an LlmCallError instance', () => {
    expect(isLlmCallError(new LlmCallError(turn()))).toBe(true);
    expect(isLlmCallError(new Error('plain'))).toBe(false);
    expect(isLlmCallError({ turn })).toBe(false);
    expect(isLlmCallError(null)).toBe(false);
    expect(isLlmCallError('nope')).toBe(false);
  });
});

describe('rateLimitInfo', () => {
  it('returns reset hints for the wait-and-resume classes', () => {
    for (const cls of ['rate_limited', 'overloaded', 'usage_limit'] as const) {
      const err = new LlmCallError(turn({ class: cls, resetAt: 123, retryAfterMs: 456 }));
      expect(rateLimitInfo(err)).toEqual({ resetAt: 123, retryAfterMs: 456 });
    }
  });

  it('returns null for non-backpressure classes', () => {
    for (const cls of ['permanent', 'auth', 'timeout', 'agent_crash'] as const) {
      expect(rateLimitInfo(new LlmCallError(turn({ class: cls })))).toBeNull();
    }
  });

  it('returns null for a non-LlmCallError', () => {
    expect(rateLimitInfo(new Error('429 rate limited'))).toBeNull();
    expect(rateLimitInfo(null)).toBeNull();
    expect(rateLimitInfo({ class: 'rate_limited' })).toBeNull();
  });

  it('propagates undefined hints when the turn lacks them', () => {
    expect(rateLimitInfo(new LlmCallError(turn({ class: 'overloaded' })))).toEqual({
      resetAt: undefined,
      retryAfterMs: undefined,
    });
  });
});
