// @vitest-environment jsdom
/**
 * <DomainTestPanel> — the interactive k6 controls (P-010) + the optional SSE
 * streaming run path (P-011) of testing-shell-cross-project-2026-06-01.
 *
 * A synthetic k6 domain is the consumer here (neither shipping app routes k6
 * through DomainTestPanel today — D-009): the fake dataSource serves a section
 * of k6 runners and these pin the panel's new behavior.
 *  - k6 runners render a category badge + VUs/duration inputs + Run.
 *  - the category filter chips hide/show runners by category.
 *  - Run dispatches the k6 descriptor (with the user's overrides) to the
 *    dataSource and surfaces the output.
 *  - when the dataSource implements streamRun, the panel uses it (live-append)
 *    instead of startRun+pollRun.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { withNuqsTestingAdapter } from 'nuqs/adapters/testing';
import DomainTestPanel from './DomainTestPanel';
import type { TestingDataSource, DomainDetail } from './data-source';

afterEach(cleanup);

const renderOpts = () => ({ wrapper: withNuqsTestingAdapter({ searchParams: '' }) });

function k6Domain(): DomainDetail {
  return {
    id: 'load',
    label: 'Load',
    description: 'k6 load suites',
    tier: 'project',
    totalFiles: 0,
    sections: [
      {
        id: 'k6',
        label: 'k6 scripts',
        files: [],
        runners: [
          { kind: 'k6', script: 'load-tests/scripts/smoke.js', vus: 5, duration: '30s', category: 'smoke' },
          { kind: 'k6', script: 'load-tests/scripts/stress.js', vus: 50, category: 'stress' },
        ],
      },
    ],
  };
}

function mockDataSource(over: Partial<TestingDataSource> = {}): TestingDataSource {
  return {
    fetchDomain: vi.fn(async () => k6Domain()),
    fetchStatuses: vi.fn(async () => ({})),
    fetchHealth: vi.fn(async () => null),
    startRun: vi.fn(async () => ({ runId: 'r1' })),
    pollRun: vi.fn(async () => ({ status: 'pass', exitCode: 0, output: 'k6 summary: ok', finishedAt: Date.now() })),
    fetchHistory: vi.fn(async () => []),
    ...over,
  };
}

describe('DomainTestPanel — k6 controls (P-010)', () => {
  it('renders a category badge + VUs/duration inputs prefilled from the runner', async () => {
    render(<DomainTestPanel domainId="load" dataSource={mockDataSource()} />, renderOpts());

    const vus = (await screen.findByLabelText('VUs for load-tests/scripts/smoke.js')) as HTMLInputElement;
    expect(vus.value).toBe('5');
    const dur = screen.getByLabelText('Duration for load-tests/scripts/smoke.js') as HTMLInputElement;
    expect(dur.value).toBe('30s');
    // stress runner has no duration → empty, placeholder 'default'
    const stressDur = screen.getByLabelText('Duration for load-tests/scripts/stress.js') as HTMLInputElement;
    expect(stressDur.value).toBe('');
  });

  it('renders one filter chip per present category, defaulting to "all"', async () => {
    render(<DomainTestPanel domainId="load" dataSource={mockDataSource()} />, renderOpts());
    const group = await screen.findByRole('group', { name: /Filter k6 runners/ });
    expect(within(group).getByText('all')).toBeTruthy();
    expect(within(group).getByText('Smoke')).toBeTruthy();
    expect(within(group).getByText('Stress')).toBeTruthy();
  });

  it('filtering by category hides non-matching k6 runners', async () => {
    render(<DomainTestPanel domainId="load" dataSource={mockDataSource()} />, renderOpts());
    await screen.findByTitle('Run k6 load-tests/scripts/smoke.js');
    const group = screen.getByRole('group', { name: /Filter k6 runners/ });

    fireEvent.click(within(group).getByText('Stress'));
    expect(screen.queryByTitle('Run k6 load-tests/scripts/smoke.js')).toBeNull();
    expect(screen.getByTitle('Run k6 load-tests/scripts/stress.js')).toBeTruthy();

    fireEvent.click(within(group).getByText('all'));
    expect(screen.getByTitle('Run k6 load-tests/scripts/smoke.js')).toBeTruthy();
  });

  it('Run dispatches the k6 descriptor with the user VUs/duration overrides', async () => {
    const ds = mockDataSource();
    render(<DomainTestPanel domainId="load" dataSource={ds} />, renderOpts());

    const vus = (await screen.findByLabelText('VUs for load-tests/scripts/smoke.js')) as HTMLInputElement;
    fireEvent.change(vus, { target: { value: '12' } });
    fireEvent.change(screen.getByLabelText('Duration for load-tests/scripts/smoke.js'), { target: { value: '1m' } });
    fireEvent.click(screen.getByTitle('Run k6 load-tests/scripts/smoke.js'));

    await waitFor(() => expect(ds.startRun).toHaveBeenCalledTimes(1));
    expect((ds.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual({
      runner: { kind: 'k6', script: 'load-tests/scripts/smoke.js', vus: 12, duration: '1m', category: 'smoke' },
    });
    // run output surfaces in the drawer
    await waitFor(() => expect(screen.getByText(/k6 summary: ok/)).toBeTruthy());
  });
});

describe('DomainTestPanel — streamRun path (P-011)', () => {
  it('uses streamRun when present (live-append) instead of startRun/pollRun', async () => {
    const streamRun = vi.fn(
      async (_body: unknown, onLine: (l: string) => void) => {
        onLine('▶ k6 starting');
        onLine('✓ checks........: 100%');
        return { exitCode: 0 };
      },
    );
    const ds = mockDataSource({ streamRun });
    render(<DomainTestPanel domainId="load" dataSource={ds} />, renderOpts());

    fireEvent.click(await screen.findByTitle('Run k6 load-tests/scripts/smoke.js'));

    await waitFor(() => expect(streamRun).toHaveBeenCalledTimes(1));
    // streaming path is preferred — the poll path is never taken
    expect(ds.startRun).not.toHaveBeenCalled();
    expect(ds.pollRun).not.toHaveBeenCalled();
    // both streamed lines land in the drawer, and the run resolves to pass/exit 0
    await waitFor(() => {
      const out = screen.getByText(/k6 starting/);
      expect(out.textContent).toMatch(/checks/);
    });
    await waitFor(() => expect(screen.getByText(/exit 0/)).toBeTruthy());
  });

  it('falls back to startRun + pollRun when streamRun is absent', async () => {
    const ds = mockDataSource();
    render(<DomainTestPanel domainId="load" dataSource={ds} />, renderOpts());
    fireEvent.click(await screen.findByTitle('Run k6 load-tests/scripts/stress.js'));
    await waitFor(() => expect(ds.startRun).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(ds.pollRun).toHaveBeenCalled());
  });
});
