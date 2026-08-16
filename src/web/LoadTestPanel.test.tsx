// @vitest-environment jsdom
/**
 * Tests for <LoadTestPanel> — the generic k6 UI ported from Restart. Pins the
 * NEW prop seam: it fetches its script list from the injected `scriptsEndpoint`
 * (not a hardcoded path) and renders one row per script.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import LoadTestPanel from './LoadTestPanel';

afterEach(cleanup);

const SCRIPTS = [
  { id: 'smoke', name: 'Smoke Test', description: 'quick', category: 'smoke', estimatedDuration: '30s', defaultVUs: 2 },
  { id: 'stress', name: 'Stress Test', description: 'heavy', category: 'stress', estimatedDuration: '5m', defaultVUs: 50 },
];

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('/scripts')) return { ok: true, json: async () => ({ scripts: SCRIPTS }) } as Response;
    if (String(url).includes('/results')) return { ok: true, json: async () => ({ results: [] }) } as Response;
    return { ok: true, json: async () => ({}) } as Response;
  }));
});

afterEach(() => vi.unstubAllGlobals());

describe('LoadTestPanel', () => {
  it('fetches scripts from the injected endpoint and renders a row per script', async () => {
    render(
      <LoadTestPanel
        scriptsEndpoint="/api/load-tests/scripts"
        runEndpoint="/api/load-tests/run"
        stopEndpoint="/api/load-tests/stop"
        resultsEndpoint="/api/load-tests/results"
        project="restart"
      />,
    );
    // 'Stress Test' appears only in the aside (it's not the auto-selected first script).
    await waitFor(() => expect(screen.getByText('Stress Test')).toBeTruthy());
    // 'Smoke Test' is the auto-selected first script → appears in BOTH the aside row and the config header.
    expect(screen.getAllByText('Smoke Test').length).toBeGreaterThanOrEqual(1);
    // the project query is threaded onto the scripts fetch
    const calls = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some((c) => String(c[0]).includes('/api/load-tests/scripts?project=restart'))).toBe(true);
  });

  it('shows an empty-state when there are no scripts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ scripts: [] }) }) as Response));
    render(
      <LoadTestPanel scriptsEndpoint="/s" runEndpoint="/run" stopEndpoint="/stop" resultsEndpoint="/res" />,
    );
    await waitFor(() => expect(screen.getByText(/No k6 scripts found/)).toBeTruthy());
  });
});
