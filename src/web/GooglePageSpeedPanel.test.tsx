// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import GooglePageSpeedPanel from './GooglePageSpeedPanel';
import type { PageSpeedRecord } from '../pagespeed';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function record(
  id: string,
  createdAt: string,
  perf: number,
  lcpMs: number,
  lcpDisplay: string,
): PageSpeedRecord {
  const lab = (numericValue: number, displayValue: string) => ({ numericValue, displayValue });
  return {
    id,
    project: 'restart',
    createdAt,
    requestedUrl: 'https://shop.buyrestart.com/',
    finalUrl: 'https://shop.buyrestart.com/',
    strategy: 'mobile',
    fetchedAt: createdAt,
    categories: { performance: perf, accessibility: 95, bestPractices: 100, seo: 92 },
    metrics: {
      lcp: lab(lcpMs, lcpDisplay),
      fcp: lab(1600, '1.6 s'),
      cls: lab(0, '0'),
      tbt: lab(350, '350 ms'),
      speedIndex: lab(4500, '4.5 s'),
      tti: lab(5000, '5.0 s'),
    },
    fieldData: null,
    opportunities: [],
    reportUrl: 'https://pagespeed.web.dev/analysis?url=x&form_factor=mobile',
  };
}

const NEW = record('r2', '2026-06-03T02:00:00Z', 85, 3000, '3.0 s');
const OLD = record('r1', '2026-06-03T01:00:00Z', 80, 4000, '4.0 s');

function stubFetch(results: PageSpeedRecord[], postResult?: { ok?: boolean; body: unknown }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return { ok: postResult?.ok ?? true, json: async () => postResult?.body ?? { id: 'r2', summary: NEW } } as Response;
      }
      const u = String(input);
      if (u.includes('/urls')) return { ok: true, json: async () => ({ urls: [{ url: 'https://shop.buyrestart.com/', count: results.length, lastRunAt: '2026-06-03T02:00:00Z' }] }) } as Response;
      if (u.includes('/results')) return { ok: true, json: async () => ({ results }) } as Response;
      return { ok: true, json: async () => ({}) } as Response;
    }),
  );
}

const props = {
  runEndpoint: '/api/google-pagespeed/run',
  resultsEndpoint: '/api/google-pagespeed/results',
  urlsEndpoint: '/api/google-pagespeed/urls',
  defaultUrl: 'https://shop.buyrestart.com',
};

describe('GooglePageSpeedPanel', () => {
  beforeEach(() => stubFetch([NEW, OLD]));

  it('defaults the URL and renders the newest report with delta arrows vs the previous report', async () => {
    render(<GooglePageSpeedPanel {...props} />);
    expect((screen.getByLabelText('URL to test') as HTMLInputElement).value).toBe('https://shop.buyrestart.com');
    // Loads history on mount → newest report (perf 85) renders with deltas vs OLD (perf 80, lcp 4.0s).
    await waitFor(() => expect(screen.getByText('3.0 s')).toBeTruthy()); // LCP lab metric (scorecard only)
    expect(screen.getAllByText('85').length).toBeGreaterThan(0); // perf score badge (+ history row)
    const improved = screen.getAllByLabelText(/improved/);
    expect(improved.length).toBeGreaterThan(0); // perf up + lcp down both improved
    expect(improved.some((el) => /%/.test(el.textContent ?? ''))).toBe(true); // shows a % next to the arrow
    // history is queried with the NORMALIZED url (trailing slash) so it matches saved rows
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/results') && String(c[0]).includes('shop.buyrestart.com%2F'))).toBe(true);
  });

  it('runs a new report on click (POST to runEndpoint)', async () => {
    render(<GooglePageSpeedPanel {...props} />);
    await waitFor(() => expect(screen.getByText('3.0 s')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /run/i }));
    await waitFor(() =>
      expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.some((c) => (c[1] as RequestInit)?.method === 'POST')).toBe(true),
    );
  });

  it('shows the server error message when the run fails (e.g. 429 quota)', async () => {
    stubFetch([], { ok: false, body: { error: 'PageSpeed API 429: Quota exceeded' } });
    render(<GooglePageSpeedPanel {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /run/i }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/429/));
  });

  it('shows no delta arrows for the first/only report (no prior to compare)', async () => {
    stubFetch([OLD]); // single report
    render(<GooglePageSpeedPanel {...props} />);
    await waitFor(() => expect(screen.getByText('4.0 s')).toBeTruthy()); // OLD's LCP (scorecard)
    expect(screen.queryAllByLabelText(/improved|regressed/)).toHaveLength(0);
  });

  it('selecting an older report from the history list shows it', async () => {
    render(<GooglePageSpeedPanel {...props} />);
    await waitFor(() => expect(screen.getByText('3.0 s')).toBeTruthy());
    // History rows render both reports; the older (perf 80) appears only in its row → click it.
    fireEvent.click(screen.getByText('80'));
    await waitFor(() => {
      // OLD is the oldest → no previous → its LCP (4.0 s) shows without a delta arrow.
      expect(screen.getByText('4.0 s')).toBeTruthy();
    });
  });
});
