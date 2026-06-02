/**
 * Tests for visibleTabs — the platform-variant selection filter (P-001 of
 * testing-shell-platform-variants-2026-06-01).
 *
 * A tab with no `platform` is platform-agnostic (always shown). A tab tagged
 * 'desktop'/'web' shows only on the matching platform — except when the host
 * declares 'both', where everything shows ("both shows both").
 */
import { describe, it, expect } from 'vitest';
import { visibleTabs } from './platform';

const tabs = [
  { id: 'ci', platform: undefined },         // agnostic
  { id: 'chaos', platform: 'desktop' as const },
  { id: 'chaos-web', platform: 'web' as const },
  { id: 'live', platform: 'desktop' as const },
  { id: 'live-web', platform: 'web' as const },
];

describe('visibleTabs', () => {
  it("shows agnostic + matching tabs on 'desktop'", () => {
    expect(visibleTabs(tabs, 'desktop').map((t) => t.id)).toEqual(['ci', 'chaos', 'live']);
  });

  it("shows agnostic + matching tabs on 'web'", () => {
    expect(visibleTabs(tabs, 'web').map((t) => t.id)).toEqual(['ci', 'chaos-web', 'live-web']);
  });

  it("shows everything on 'both'", () => {
    expect(visibleTabs(tabs, 'both').map((t) => t.id)).toEqual(['ci', 'chaos', 'chaos-web', 'live', 'live-web']);
  });

  it('preserves order and does not mutate the input', () => {
    const copy = [...tabs];
    visibleTabs(tabs, 'web');
    expect(tabs).toEqual(copy);
  });
});
