/**
 * Tests for the chaos-runner pure helpers (P-004 of
 * testing-shell-platform-variants-2026-06-01). The Playwright driving is in a
 * `main()` that dynamically imports playwright, so importing this module for
 * the helpers never launches a browser.
 */
import { describe, it, expect } from 'vitest';
import { formatEvent, clampSteps, pickIndex } from './chaos-runner.mjs';

describe('chaos-runner helpers', () => {
  it('formatEvent emits one NDJSON line (trailing newline, round-trips)', () => {
    const line = formatEvent({ type: 'step', n: 1, action: 'click', ok: true });
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line)).toEqual({ type: 'step', n: 1, action: 'click', ok: true });
  });

  it('clampSteps bounds to [1, 200] and defaults NaN to 1', () => {
    expect(clampSteps(0)).toBe(1);
    expect(clampSteps(5)).toBe(5);
    expect(clampSteps(99999)).toBe(200);
    expect(clampSteps(Number.NaN)).toBe(1);
  });

  it('pickIndex maps a [0,1) value to a valid index, -1 when empty', () => {
    expect(pickIndex(4, 0)).toBe(0);
    expect(pickIndex(4, 0.99)).toBe(3);
    expect(pickIndex(0, 0.5)).toBe(-1);
  });
});
