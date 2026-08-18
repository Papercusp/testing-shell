/**
 * Tests for the census job orchestration (P-002).
 *
 * The store is a fake here on purpose — every property worth asserting about the JOB is about
 * which providers ran, what the diff decided, and whether the write was allowed. None of that
 * needs a database, and a test that needs one gets run far less often.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_MASS_RETIREMENT_THRESHOLD, runCensus, type CensusStore, type ProviderRegistration } from './run.js';
import type { ExistingSurface, ObservedSurface, SurfaceCensusProvider } from './types.js';

const scope = { workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp' };

const surface = (kind: string, surfaceId: string): ObservedSurface => ({
  kind,
  surfaceId,
  fidelity: 'declared',
});

const existingRow = (
  id: number,
  kind: string,
  surfaceId: string,
  overrides: Partial<ExistingSurface> = {},
): ExistingSurface => ({
  id,
  kind,
  surfaceId,
  provider: 'hono-routes',
  fidelity: 'declared',
  ...overrides,
});

const registration = (
  provider: string,
  overrides: Partial<ProviderRegistration> = {},
): ProviderRegistration => ({ provider, config: {}, enabled: true, source: 'template', ...overrides });

function fakeStore(
  registrations: ProviderRegistration[],
  existing: ExistingSurface[],
): CensusStore & { written: { upserted: number; retired: number }[]; lastRetires: unknown[] } {
  const written: { upserted: number; retired: number }[] = [];
  let lastRetires: unknown[] = [];
  return {
    written,
    get lastRetires() {
      return lastRetires;
    },
    loadRegistrations: async () => registrations,
    loadExisting: async () => existing,
    applyDiff: async (_scope, diff) => {
      lastRetires = diff.retires;
      const result = { upserted: diff.upserts.length, retired: diff.retires.length };
      written.push(result);
      return result;
    },
  };
}

const provider = (
  id: string,
  kinds: string[],
  enumerate: () => ObservedSurface[],
): SurfaceCensusProvider => ({ provider: id, kinds, enumerate });

describe('runCensus — provider selection', () => {
  it('skips a disabled registration and does NOT retire its kinds', async () => {
    const report = await runCensus({
      scope,
      repoRoot: '/repo',
      store: fakeStore(
        [registration('hono-routes', { enabled: false })],
        [existingRow(1, 'http-route', 'GET /api/a')],
      ),
      providers: [provider('hono-routes', ['http-route'], () => [])],
    });

    expect(report.ranProviders).toEqual([]);
    expect(report.disabledProviders).toEqual(['hono-routes']);
    // The whole point: a provider that did not run cannot delete the census's knowledge.
    expect(report.diff.retires).toEqual([]);
    expect(report.applied).toEqual({ upserted: 0, retired: 0 });
  });

  it('reports a registration with no implementation instead of silently ignoring it', async () => {
    const report = await runCensus({
      scope,
      repoRoot: '/repo',
      store: fakeStore([registration('next-routes')], []),
      providers: [],
    });

    expect(report.unimplementedProviders).toEqual(['next-routes']);
    expect(report.ranProviders).toEqual([]);
  });

  it('a throwing provider is reported and its kinds survive the run', async () => {
    const report = await runCensus({
      scope,
      repoRoot: '/repo',
      store: fakeStore(
        [registration('hono-routes'), registration('mcp-tools')],
        [existingRow(1, 'http-route', 'GET /api/a'), existingRow(2, 'mcp-tool', 'x:y', { provider: 'mcp-tools' })],
      ),
      providers: [
        provider('hono-routes', ['http-route'], () => {
          throw new Error('registry not loaded');
        }),
        provider('mcp-tools', ['mcp-tool'], () => [surface('mcp-tool', 'x:y')]),
      ],
    });

    expect(report.failedProviders).toEqual([
      { provider: 'hono-routes', error: 'registry not loaded' },
    ]);
    expect(report.diff.retires).toEqual([]);
    expect(report.applied?.retired).toBe(0);
  });
});

describe('runCensus — the mass-retirement circuit breaker', () => {
  const live = [
    existingRow(1, 'http-route', 'GET /a'),
    existingRow(2, 'http-route', 'GET /b'),
    existingRow(3, 'http-route', 'GET /c'),
    existingRow(4, 'http-route', 'GET /d'),
  ];

  it('refuses retirements above the threshold, still applies upserts, and says so', async () => {
    const store = fakeStore([registration('hono-routes')], live);
    // Enumerates only 1 of 4 — a successful run, so scoping alone would happily retire 3/4.
    const report = await runCensus({
      scope,
      repoRoot: '/repo',
      store,
      providers: [provider('hono-routes', ['http-route'], () => [surface('http-route', 'GET /a')])],
    });

    expect(report.retirementBlocked).toEqual({
      reason: 'mass-retirement',
      wouldRetire: 3,
      liveRows: 4,
      threshold: DEFAULT_MASS_RETIREMENT_THRESHOLD,
    });
    // The diff still TELLS you what it wanted to do — the breaker suppresses the write, not the
    // finding, so an operator can see the 3 surfaces and decide.
    expect(report.diff.retires).toHaveLength(3);
    expect(report.applied).toEqual({ upserted: 1, retired: 0 });
    expect(store.lastRetires).toEqual([]);
  });

  it('allows a retirement below the threshold', async () => {
    const store = fakeStore([registration('hono-routes')], live);
    const report = await runCensus({
      scope,
      repoRoot: '/repo',
      store,
      providers: [
        provider('hono-routes', ['http-route'], () => [
          surface('http-route', 'GET /a'),
          surface('http-route', 'GET /b'),
          surface('http-route', 'GET /c'),
        ]),
      ],
    });

    expect(report.retirementBlocked).toBeNull();
    expect(report.applied).toEqual({ upserted: 3, retired: 1 });
  });

  it('allowMassRetirement lets a deliberate large deprecation through', async () => {
    const report = await runCensus({
      scope,
      repoRoot: '/repo',
      store: fakeStore([registration('hono-routes')], live),
      providers: [provider('hono-routes', ['http-route'], () => [])],
      allowMassRetirement: true,
    });

    expect(report.retirementBlocked).toBeNull();
    expect(report.applied).toEqual({ upserted: 0, retired: 4 });
  });

  it('does not fire on a first run, where there is nothing live to retire', async () => {
    const report = await runCensus({
      scope,
      repoRoot: '/repo',
      store: fakeStore([registration('hono-routes')], []),
      providers: [provider('hono-routes', ['http-route'], () => [surface('http-route', 'GET /a')])],
    });

    expect(report.retirementBlocked).toBeNull();
    expect(report.applied).toEqual({ upserted: 1, retired: 0 });
  });
});
