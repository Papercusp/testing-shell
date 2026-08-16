/**
 * Tests for aggregateJUnitCases — the pure JUnit rollup (P-012 data layer
 * of testing-shell-cross-project-2026-06-01).
 *
 * Restart's /tests page is exactly a JUnit aggregator; porting the rollup
 * here lets both projects share one impl. Parsing junit.xml stays in each
 * consumer's backend (fast-xml-parser + fs) — the lib stays dependency-free
 * and takes already-normalized cases.
 */
import { describe, it, expect } from 'vitest';
import { aggregateJUnitCases, type JUnitCase } from './junit';

const cases: JUnitCase[] = [
  { project: 'libs/a', file: 'libs/a/junit.xml', suite: 'a', test: 't1', status: 'passed', durationSec: 5 },
  { project: 'libs/a', file: 'libs/a/junit.xml', suite: 'a', test: 't2', status: 'failed', durationSec: 2, failure: 'boom' },
  { project: 'libs/b', file: 'libs/b/junit.xml', suite: 'b', test: 't3', status: 'skipped', durationSec: 0 },
  { project: 'libs/b', file: 'libs/b/junit.xml', suite: 'b', test: 't4', status: 'errored', durationSec: 1 },
];

describe('aggregateJUnitCases', () => {
  it('rolls up totals across all cases', () => {
    const { totals } = aggregateJUnitCases(cases);
    expect(totals).toEqual({
      files: 2,
      cases: 4,
      passed: 1,
      failed: 1,
      skipped: 1,
      errored: 1,
      durationSec: 8,
    });
  });

  it('produces one summary per file with per-status counts', () => {
    const { files } = aggregateJUnitCases(cases);
    const a = files.find((f) => f.file === 'libs/a/junit.xml');
    expect(a).toMatchObject({ project: 'libs/a', total: 2, passed: 1, failed: 1, skipped: 0, errored: 0, durationSec: 7 });
    const b = files.find((f) => f.file === 'libs/b/junit.xml');
    expect(b).toMatchObject({ project: 'libs/b', total: 2, skipped: 1, errored: 1, passed: 0, failed: 0 });
  });

  it('returns zeroed totals and no files for an empty input', () => {
    expect(aggregateJUnitCases([])).toEqual({
      files: [],
      totals: { files: 0, cases: 0, passed: 0, failed: 0, skipped: 0, errored: 0, durationSec: 0 },
    });
  });
});
