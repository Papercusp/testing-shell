/**
 * Tests for the census diff (P-002).
 *
 * FALSIFIABILITY DISCIPLINE: the repo's mutation-probe rules say a guard that has never failed is
 * a guard you have not tested, and that proving it by mutating the shared tree is unsafe here
 * (the git-sync sweep can commit the mutant). So the control lives permanently IN this file:
 * `naiveDiffCensus` is the obvious-but-wrong implementation — the one that retires anything the
 * providers did not enumerate — and the suite asserts it FAILS the same safety property the real
 * implementation passes. If someone weakens diffCensus into that shape, the calibration test
 * stops distinguishing them and goes red.
 */

import { describe, expect, it } from 'vitest';

import { diffCensus, runProvider, type CensusDiff } from './diff.js';
import type { ExistingSurface, ObservedSurface, ProviderRun } from './types.js';

const surface = (
  kind: string,
  surfaceId: string,
  overrides: Partial<ObservedSurface> = {},
): ObservedSurface => ({ kind, surfaceId, fidelity: 'declared', ...overrides });

const existing = (
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

const okRun = (
  provider: string,
  kinds: string[],
  surfaces: ObservedSurface[],
): ProviderRun => ({ provider, kinds, status: 'ok', surfaces });

const failedRun = (provider: string, kinds: string[], error = 'boom'): ProviderRun => ({
  provider,
  kinds,
  status: 'failed',
  error,
});

/**
 * THE DELIBERATELY-WRONG CONTROL. Retires every live row the run did not re-enumerate, with no
 * notion of retirement scope. This is what a reasonable person writes first, and it converts a
 * crashed provider into a mass retirement.
 */
function naiveDiffCensus(
  providerRuns: readonly ProviderRun[],
  live: readonly ExistingSurface[],
): Pick<CensusDiff, 'retires'> {
  const seen = new Set<string>();
  for (const run of providerRuns) {
    if (run.status !== 'ok') continue;
    for (const s of run.surfaces) seen.add(`${s.kind} ${s.surfaceId}`);
  }
  return {
    retires: live
      .filter((row) => !row.retiredAt && !seen.has(`${row.kind} ${row.surfaceId}`))
      .map((row) => ({
        id: row.id,
        kind: row.kind,
        surfaceId: row.surfaceId,
        provider: row.provider,
      })),
  };
}

describe('diffCensus — retirement safety (the dangerous direction)', () => {
  const live = [
    existing(1, 'http-route', 'GET /api/a'),
    existing(2, 'http-route', 'POST /api/b'),
    existing(3, 'mcp-tool', 'widgets:list', { provider: 'mcp-tools' }),
  ];

  it('a FAILED provider retires NOTHING of its kinds', () => {
    const diff = diffCensus(
      [failedRun('hono-routes', ['http-route']), okRun('mcp-tools', ['mcp-tool'], [surface('mcp-tool', 'widgets:list')])],
      live,
    );

    expect(diff.retires).toEqual([]);
    expect(diff.retirableKinds).toEqual(['mcp-tool']);
    expect(diff.failedProviders).toEqual([{ provider: 'hono-routes', error: 'boom' }]);
  });

  it('CALIBRATION: the naive implementation mass-retires on that same input', () => {
    // Proves the assertion above actually discriminates — it is not passing vacuously.
    const naive = naiveDiffCensus(
      [failedRun('hono-routes', ['http-route']), okRun('mcp-tools', ['mcp-tool'], [surface('mcp-tool', 'widgets:list')])],
      live,
    );
    expect(naive.retires.map((r) => r.surfaceId).sort()).toEqual(['GET /api/a', 'POST /api/b']);
  });

  it('a kind owned by BOTH an ok and a failed provider is not retirable', () => {
    const diff = diffCensus(
      [
        okRun('hono-routes', ['http-route'], [surface('http-route', 'GET /api/a')]),
        failedRun('openapi-spec', ['http-route']),
      ],
      live,
    );

    expect(diff.retires).toEqual([]);
    expect(diff.retirableKinds).toEqual([]);
    expect(diff.skippedKinds).toEqual(['http-route']);
  });

  it('retires a genuinely-absent surface when its kind WAS fully enumerated', () => {
    const diff = diffCensus(
      [okRun('hono-routes', ['http-route'], [surface('http-route', 'GET /api/a')])],
      live,
    );

    expect(diff.retires.map((r) => r.surfaceId)).toEqual(['POST /api/b']);
    // mcp-tool was never enumerated this run, so its row is untouched.
    expect(diff.retires.some((r) => r.kind === 'mcp-tool')).toBe(false);
  });

  it('does not re-retire an already-retired row', () => {
    const diff = diffCensus(
      [okRun('hono-routes', ['http-route'], [])],
      [existing(9, 'http-route', 'GET /api/gone', { retiredAt: '2026-01-01T00:00:00Z' })],
    );
    expect(diff.retires).toEqual([]);
  });
});

describe('diffCensus — a returning surface keeps its identity', () => {
  it('marks a retired-but-returning surface unretire, never a fresh insert', () => {
    const diff = diffCensus(
      [okRun('hono-routes', ['http-route'], [surface('http-route', 'GET /api/back')])],
      [existing(7, 'http-route', 'GET /api/back', { retiredAt: '2026-01-01T00:00:00Z' })],
    );

    expect(diff.upserts).toHaveLength(1);
    // Load-bearing: the applier keys off this to clear retired_at WITHOUT touching first_seen.
    // Resetting first_seen would make an old surface look new and red the new-surface gate.
    expect(diff.upserts[0].unretire).toBe(true);
  });

  it('a surface that never left is not flagged unretire', () => {
    const diff = diffCensus(
      [okRun('hono-routes', ['http-route'], [surface('http-route', 'GET /api/a')])],
      [existing(1, 'http-route', 'GET /api/a')],
    );
    expect(diff.upserts[0].unretire).toBe(false);
  });
});

describe('diffCensus — identity collisions between providers', () => {
  it('the strongest fidelity wins and the collision is reported, not silently dropped', () => {
    const diff = diffCensus(
      [
        okRun('openapi-spec', ['http-route'], [surface('http-route', 'GET /api/a', { fidelity: 'spec' })]),
        okRun('hono-routes', ['http-route'], [surface('http-route', 'GET /api/a', { fidelity: 'declared' })]),
      ],
      [],
    );

    expect(diff.upserts).toHaveLength(1);
    expect(diff.upserts[0].provider).toBe('hono-routes');
    expect(diff.upserts[0].fidelity).toBe('declared');
    expect(diff.collisions).toEqual([
      { kind: 'http-route', surfaceId: 'GET /api/a', winner: 'hono-routes', losers: ['openapi-spec'], reason: 'fidelity' },
    ]);
  });

  it('an equal-fidelity tie breaks deterministically by provider name', () => {
    const run = () =>
      diffCensus(
        [
          okRun('zzz-provider', ['http-route'], [surface('http-route', 'GET /api/a')]),
          okRun('aaa-provider', ['http-route'], [surface('http-route', 'GET /api/a')]),
        ],
        [],
      );

    expect(run().upserts[0].provider).toBe('aaa-provider');
    expect(run().collisions[0].reason).toBe('provider-order');
    // Byte-identical across runs: an unstable winner would churn provider on every census.
    expect(JSON.stringify(run())).toEqual(JSON.stringify(run()));
  });
});

describe('diffCensus — provider hygiene reporting', () => {
  it('reports a provider emitting the same surface twice', () => {
    const diff = diffCensus(
      [
        okRun('hono-routes', ['http-route'], [
          surface('http-route', 'GET /api/a'),
          surface('http-route', 'GET /api/a'),
        ]),
      ],
      [],
    );

    expect(diff.duplicates).toEqual([
      { provider: 'hono-routes', kind: 'http-route', surfaceId: 'GET /api/a', count: 2 },
    ]);
    // Still upserted once — a duplicate is a provider bug to report, not a reason to lose the row.
    expect(diff.upserts).toHaveLength(1);
  });

  it('an empty successful run legitimately retires its kind (a real deletion)', () => {
    const diff = diffCensus(
      [okRun('hono-routes', ['http-route'], [])],
      [existing(1, 'http-route', 'GET /api/a')],
    );
    expect(diff.retires.map((r) => r.surfaceId)).toEqual(['GET /api/a']);
  });
});

describe('runProvider — a crash degrades to blind, never to empty', () => {
  it('converts a throw into a failed run carrying the message', async () => {
    const result = await runProvider(
      {
        provider: 'hono-routes',
        kinds: ['http-route'],
        enumerate: () => {
          throw new Error('registry not loaded');
        },
      },
      undefined as never,
    );

    expect(result.status).toBe('failed');
    expect(result).toMatchObject({ error: 'registry not loaded' });
  });

  it('rejects a non-array return rather than treating it as zero surfaces', async () => {
    const result = await runProvider(
      {
        provider: 'broken',
        kinds: ['http-route'],
        enumerate: () => undefined as unknown as ObservedSurface[],
      },
      undefined as never,
    );

    expect(result.status).toBe('failed');
    // The whole point: `undefined` must not read as "no surfaces exist" and retire the kind.
    expect(diffCensus([result], [existing(1, 'http-route', 'GET /api/a')]).retires).toEqual([]);
  });

  it('passes through a successful enumeration', async () => {
    const result = await runProvider(
      {
        provider: 'hono-routes',
        kinds: ['http-route'],
        enumerate: () => [surface('http-route', 'GET /api/a')],
      },
      undefined as never,
    );

    expect(result).toMatchObject({ status: 'ok', provider: 'hono-routes' });
  });
});
