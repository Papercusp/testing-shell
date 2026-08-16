// @vitest-environment jsdom
/**
 * Tests for <AdoptionMatrixPanel> — the testing-spec adoption matrix promoted
 * out of Restart's apps/web/components/dashboards/AdoptionMatrix into the
 * shared lib (testing-shell-cross-project). The render is a verbatim
 * extraction; these tests pin the NEW host-injection seam the lib adds on
 * top: `load(signal)` is called on mount, re-run only when `reloadKey`
 * changes (not on every re-render), the signal aborts on unmount, and a
 * rejected load surfaces as an error.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import AdoptionMatrixPanel, { type AdoptionMatrix } from './AdoptionMatrix';

afterEach(cleanup);

function sampleMatrix(overrides: Partial<AdoptionMatrix> = {}): AdoptionMatrix {
  return {
    project: 'sample',
    scannedAt: 0,
    scanRoot: '/tmp/sample',
    packages: [
      {
        workspace: 'libs/foo',
        name: '@x/foo',
        hasTestingMd: true,
        hasUnitTestScript: true,
        hasIntegrationTestScript: false,
        hasVitestConfig: true,
        usesDefineVitestConfig: true,
        unitTestFiles: 3,
        integrationTestFiles: 0,
        benchFiles: 0,
        propertyTestFiles: 1,
        hasStorybook: false,
        hasLostPixelConfig: false,
        baselineCount: 0,
        storyFiles: 0,
      },
    ],
    totals: {
      packages: 1,
      withTestingMd: 1,
      withUnitTests: 1,
      withIntegrationTests: 0,
      withStorybook: 0,
      withVisualRegression: 0,
      totalBaselines: 0,
    },
    ...overrides,
  };
}

describe('AdoptionMatrixPanel', () => {
  it('calls load(signal) on mount and renders the matrix', async () => {
    const load = vi.fn(async (_signal: AbortSignal) => sampleMatrix());
    render(<AdoptionMatrixPanel load={load} reloadKey="sample" />);

    expect(load).toHaveBeenCalledTimes(1);
    expect(load.mock.calls[0][0]).toBeInstanceOf(AbortSignal);

    await waitFor(() => expect(screen.getByText('@x/foo')).toBeTruthy());
    expect(screen.getByText('libs/foo')).toBeTruthy(); // workspace path in the row
  });

  it('renders an error message when load rejects', async () => {
    const load = vi.fn(async () => {
      throw new Error('scan blew up');
    });
    render(<AdoptionMatrixPanel load={load} reloadKey="x" />);
    await waitFor(() => expect(screen.getByText(/scan blew up/)).toBeTruthy());
  });

  it('re-runs load only when reloadKey changes, not on unrelated re-render', async () => {
    const load = vi.fn(async () => sampleMatrix());
    const { rerender } = render(<AdoptionMatrixPanel load={load} reloadKey="a" />);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));

    // Same reloadKey, brand-new load identity → must NOT refetch.
    const unusedLoad = vi.fn(async () => sampleMatrix());
    rerender(<AdoptionMatrixPanel load={unusedLoad} reloadKey="a" />);
    expect(load).toHaveBeenCalledTimes(1);
    expect(unusedLoad).toHaveBeenCalledTimes(0);

    // Changed reloadKey → refetch with the latest load.
    const load2 = vi.fn(async () => sampleMatrix({ project: 'b' }));
    rerender(<AdoptionMatrixPanel load={load2} reloadKey="b" />);
    await waitFor(() => expect(load2).toHaveBeenCalledTimes(1));
  });

  it('aborts the in-flight load signal on unmount', async () => {
    let captured: AbortSignal | undefined;
    const load = vi.fn(async (signal: AbortSignal) => {
      captured = signal;
      return sampleMatrix();
    });
    const { unmount } = render(<AdoptionMatrixPanel load={load} reloadKey="a" />);
    expect(captured?.aborted).toBe(false);
    unmount();
    expect(captured?.aborted).toBe(true);
  });
});
