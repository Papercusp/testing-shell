import { describe, it, expect } from 'vitest';
import {
  K6_CATEGORIES,
  k6CategoryColor,
  k6CategoryLabel,
  k6CategoriesPresent,
  visibleByCategory,
  runnerCategory,
  type CategorizedRunner,
} from './k6';

describe('k6 category helpers', () => {
  it('maps known categories to a stable color + label', () => {
    expect(k6CategoryColor('stress')).toBe('#f97316');
    expect(k6CategoryLabel('spike')).toBe('Spike');
  });

  it('falls back for unknown categories (color grey, label verbatim)', () => {
    expect(k6CategoryColor('nonsense')).toBe('#94a3b8');
    expect(k6CategoryLabel('nonsense')).toBe('nonsense');
  });

  it('defaults a categoryless runner to load', () => {
    expect(runnerCategory({ kind: 'k6' })).toBe('load');
    expect(k6CategoryLabel(undefined)).toBe('Load');
  });

  it('lists only the categories actually present, in canonical order', () => {
    const runners: CategorizedRunner[] = [
      { kind: 'k6', category: 'soak' },
      { kind: 'k6', category: 'smoke' },
      { kind: 'vitest' }, // non-k6, ignored
      { kind: 'k6' }, // categoryless → load
    ];
    expect(k6CategoriesPresent(runners)).toEqual(['smoke', 'load', 'soak']);
  });

  it('returns no chips when there are no k6 runners', () => {
    expect(k6CategoriesPresent([{ kind: 'vitest' }, { kind: 'cargo' }])).toEqual([]);
  });

  it('K6_CATEGORIES is the full canonical set', () => {
    expect(K6_CATEGORIES).toEqual(['smoke', 'load', 'stress', 'spike', 'soak', 'browser']);
  });

  describe('visibleByCategory', () => {
    const runners: CategorizedRunner[] = [
      { kind: 'k6', category: 'smoke' },
      { kind: 'k6', category: 'stress' },
      { kind: 'k6' }, // → load
      { kind: 'vitest' },
    ];

    it('"all" / empty shows everything', () => {
      expect(visibleByCategory(runners, 'all')).toHaveLength(4);
      expect(visibleByCategory(runners, null)).toHaveLength(4);
      expect(visibleByCategory(runners, undefined)).toHaveLength(4);
    });

    it('a specific category keeps matching k6 runners + every non-k6 runner', () => {
      const out = visibleByCategory(runners, 'stress');
      expect(out).toEqual([
        { kind: 'k6', category: 'stress' },
        { kind: 'vitest' },
      ]);
    });

    it('matches a categoryless k6 runner under load', () => {
      const out = visibleByCategory(runners, 'load');
      expect(out).toEqual([{ kind: 'k6' }, { kind: 'vitest' }]);
    });
  });
});
