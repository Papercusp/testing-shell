import { describe, it, expect } from 'vitest';

import { findEventsAfter, deltaTextAfter } from '../tape-ordering';
import type { SseEvent } from '../types';

const ev = (name: string, data?: unknown): SseEvent => ({ name, data: data ?? null, tMs: 0 });

describe('findEventsAfter', () => {
  it('returns [] when name absent', () => {
    expect(findEventsAfter([ev('delta'), ev('done')], 'tool_call')).toEqual([]);
  });
  it('returns events after first match', () => {
    const tape = [ev('delta'), ev('tool_call'), ev('delta'), ev('done')];
    const after = findEventsAfter(tape, 'tool_call');
    expect(after.map((e) => e.name)).toEqual(['delta', 'done']);
  });
  it('matches tool_call:<name> composite', () => {
    const tape = [
      ev('tool_call', { name: 'other:thing' }),
      ev('tool_call', { name: 'chat:ask_choice' }),
      ev('delta', { text: 'after' }),
    ];
    const after = findEventsAfter(tape, 'tool_call:chat:ask_choice');
    expect(after.map((e) => e.name)).toEqual(['delta']);
  });
});

describe('deltaTextAfter', () => {
  it('joins all post-event delta text', () => {
    const tape = [
      ev('tool_call', { name: 'chat:ask_choice' }),
      ev('delta', { text: 'leak' }),
      ev('delta', { text: 'ing' }),
      ev('done'),
    ];
    expect(deltaTextAfter(tape, 'tool_call:chat:ask_choice')).toBe('leaking');
  });
  it('returns empty when no deltas after', () => {
    const tape = [
      ev('tool_call', { name: 'chat:ask_choice' }),
      ev('done'),
    ];
    expect(deltaTextAfter(tape, 'tool_call:chat:ask_choice')).toBe('');
  });
});
