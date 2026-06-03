// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rollupRoutes, saveRun, loadRuns, clearRuns, type RecorderEvent, type RunSummary } from './recorder-channel';

// jsdom's localStorage isn't reliable under this runner; use a deterministic
// in-memory stub so the persistence round-trip is env-independent.
beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
  });
  clearRuns();
});
afterEach(() => vi.unstubAllGlobals());

describe('rollupRoutes', () => {
  it('rolls up clicks / max INP / errors per route', () => {
    const events: RecorderEvent[] = [
      { ts: 1, route: '/a', kind: 'click', target: 'btn', inp: 100 },
      { ts: 2, route: '/a', kind: 'click', target: 'btn', inp: 300 },
      { ts: 3, route: '/a', kind: 'console-error', target: 'console', detail: 'boom' },
      { ts: 4, route: '/b', kind: 'click', target: 'x', inp: 50 },
      { ts: 5, route: '/b', kind: 'unhandled-error', target: 'window', detail: 'rejected' },
    ];
    const r = rollupRoutes(events);
    expect(r['/a'].clicks).toBe(2);
    expect(r['/a'].errors).toBe(1);
    expect(r['/a'].maxInp).toBe(300);
    expect(r['/b'].clicks).toBe(1);
    expect(r['/b'].errors).toBe(1);
  });
});

describe('saveRun / loadRuns / clearRuns', () => {
  const mk = (id: string): RunSummary => ({ runId: id, startedAt: 0, endedAt: 1, durationMs: 1, clicks: 0, events: [], routes: {} });

  it('round-trips runs through localStorage, newest first', () => {
    saveRun(mk('a'));
    const after = saveRun(mk('b'));
    expect(after[0].runId).toBe('b');
    expect(loadRuns().map((r) => r.runId)).toEqual(['b', 'a']);
    clearRuns();
    expect(loadRuns()).toEqual([]);
  });

  it('caps history at 10 runs', () => {
    for (let i = 0; i < 14; i++) saveRun(mk(`r${i}`));
    expect(loadRuns()).toHaveLength(10);
    expect(loadRuns()[0].runId).toBe('r13');
  });
});
