// @vitest-environment jsdom
/**
 * Tests for <JUnitRollupPanel> — the shared CI/JUnit rollup + failing-cases
 * view (P-012 of testing-shell-cross-project-2026-06-01). The pure rollup
 * (aggregateJUnitCases) is tested in junit.test.ts; these pin the panel: it
 * lists a row per file, lists failing (failed+errored) cases capped at
 * maxFailing, shows an empty state, and renders an optional footer.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import JUnitRollupPanel from './JUnitRollupPanel';
import type { JUnitCase } from './junit';

afterEach(cleanup);

const CASES: JUnitCase[] = [
  { project: 'libs/a', file: 'libs/a/junit.xml', suite: 'S1', test: 't1', status: 'passed', durationSec: 0.5 },
  { project: 'libs/a', file: 'libs/a/junit.xml', suite: 'S1', test: 't2-broke', status: 'failed', durationSec: 0.2, failure: 'boom-msg' },
  { project: 'libs/b', file: 'libs/b/junit.xml', suite: 'S2', test: 't3-err', status: 'errored', durationSec: 1, failure: 'kaboom-msg' },
];

describe('JUnitRollupPanel', () => {
  it('renders a by-file row per distinct junit file', () => {
    render(<JUnitRollupPanel cases={CASES} scanRoot="/tmp/root" />);
    expect(screen.getByText('libs/a/junit.xml')).toBeTruthy();
    expect(screen.getByText('libs/b/junit.xml')).toBeTruthy();
    expect(screen.getByText(/By file \(2\)/)).toBeTruthy();
  });

  it('lists failing (failed + errored) cases with their messages', () => {
    render(<JUnitRollupPanel cases={CASES} scanRoot="/tmp/root" />);
    expect(screen.getByText(/Failing cases \(2\)/)).toBeTruthy();
    expect(screen.getByText('t2-broke')).toBeTruthy();
    expect(screen.getByText('t3-err')).toBeTruthy();
    expect(screen.getByText('boom-msg')).toBeTruthy();
    expect(screen.getByText('kaboom-msg')).toBeTruthy();
  });

  it('caps the failing list at maxFailing', () => {
    render(<JUnitRollupPanel cases={CASES} scanRoot="/tmp/root" maxFailing={1} />);
    expect(screen.getByText(/Failing cases \(1\)/)).toBeTruthy();
    // first failing case kept, second dropped
    expect(screen.getByText('t2-broke')).toBeTruthy();
    expect(screen.queryByText('t3-err')).toBeNull();
  });

  it('shows an empty state and no failing section when there are no cases', () => {
    render(<JUnitRollupPanel cases={[]} scanRoot="/tmp/root" />);
    // empty-state hint (the prose is split by a <code>, so anchor on the code node)
    expect(screen.getByText('CI=true npm test')).toBeTruthy();
    expect(screen.getByText(/By file \(0\)/)).toBeTruthy();
    expect(screen.queryByText(/Failing cases/)).toBeNull();
  });

  it('renders an optional footer', () => {
    render(<JUnitRollupPanel cases={CASES} footer={<div data-testid="ft">footer-here</div>} />);
    expect(screen.getByTestId('ft')).toBeTruthy();
  });
});
