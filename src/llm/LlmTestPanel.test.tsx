// @vitest-environment jsdom
/**
 * Tests for <LlmTestPanel> — the generic scenario-driven LLM-testing UI. Pins
 * the prop seam: every backend route is injected, the 4-subtab nav renders, a
 * subtab switch swaps the fetched view, and the credentials strip is gated on
 * the optional credentialsEndpoint prop. fetch is mocked per-endpoint (mirrors
 * AiExplorePanel.test.tsx's fetch mocking).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import LlmTestPanel from './LlmTestPanel';

const ENDPOINTS = {
  scenariosEndpoint: '/api/admin/llm-tests/scenarios',
  runsEndpoint: '/api/admin/llm-tests/runs',
  runDetailEndpoint: '/api/admin/llm-tests/runs',
  findingsEndpoint: '/api/admin/llm-tests/findings',
};

function json(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);
}

/** Route the mocked fetch by URL so each subtab's load resolves. */
function mockFetch() {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/scenarios')) {
      return json({ scenarios: [{ id: 'op-S01', version: 1, target: 'operator', description: 'd', persona: 'admin', runMatrix: null, realWorkspace: false, transport: 'in-process', rubricVersion: 'v1', assertCount: 2, caps: { maxTurns: 6, maxWallSecs: 120, maxCostUsd: 1 } }] });
    }
    if (url.includes('/findings')) return json({ findings: [], shapeCounts: {} });
    if (url.includes('/runs')) return json({ runs: [] });
    if (url.includes('/credentials')) return json({ anthropic_api_key: null, updated_at: null });
    return json({});
  });
}

const wrap = (ui: React.ReactElement) =>
  render(ui, { wrapper: ({ children }) => <NuqsTestingAdapter>{children}</NuqsTestingAdapter> });

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch());
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('LlmTestPanel', () => {
  it('renders the 4-subtab nav', () => {
    wrap(<LlmTestPanel {...ENDPOINTS} />);
    const nav = screen.getByRole('navigation', { name: /LLM testing subtabs/i });
    for (const label of ['Runs', 'Scenarios', 'Targets', 'Findings']) {
      expect(within(nav).getByRole('button', { name: label })).toBeTruthy();
    }
  });

  it('defaults to the Runs subtab and fetches runs', async () => {
    wrap(<LlmTestPanel {...ENDPOINTS} />);
    await waitFor(() => {
      expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.some((c) => String(c[0]).includes('/runs'))).toBe(true);
    });
    // empty-runs message renders (no scenarios table)
    expect(screen.getByText(/No runs yet/i)).toBeTruthy();
  });

  it('switches to the Scenarios subtab and renders the scenarios table', async () => {
    wrap(<LlmTestPanel {...ENDPOINTS} />);
    fireEvent.click(screen.getByRole('button', { name: 'Scenarios' }));
    await waitFor(() => {
      expect(screen.getByText('op-S01')).toBeTruthy();
    });
    // the scenarios fetch was issued against the injected endpoint
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.some((c) => String(c[0]).includes('/scenarios'))).toBe(true);
  });

  it('hides the credentials strip without credentialsEndpoint and shows it with one', () => {
    const { rerender } = wrap(<LlmTestPanel {...ENDPOINTS} />);
    expect(screen.queryByText('Anthropic API key')).toBeNull();
    rerender(
      <NuqsTestingAdapter>
        <LlmTestPanel {...ENDPOINTS} credentialsEndpoint="/api/credentials" />
      </NuqsTestingAdapter>,
    );
    expect(screen.getByText('Anthropic API key')).toBeTruthy();
  });
});
