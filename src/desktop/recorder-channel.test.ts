// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { rollupRoutes, saveRun, loadRuns, clearRuns, type RecorderEvent, type RunSummary } from './recorder-channel';
import { tagBlockedElements } from './RecorderHost';

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

describe('RecorderHost frame accounting guard', () => {
  it('resets the frame clock on focus and visibility transitions', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/desktop/RecorderHost.tsx'), 'utf8');
    expect(source).toContain("window.addEventListener('blur', resetFrameClock)");
    expect(source).toContain("window.addEventListener('focus', resetFrameClock)");
    expect(source).toContain("document.addEventListener('visibilitychange', resetFrameClock)");
    expect(source).toContain("window.removeEventListener('blur', resetFrameClock)");
    expect(source).toContain("document.removeEventListener('visibilitychange', resetFrameClock)");
  });

  it('tags only the changed subtree during mutation handling — never rescans document', () => {
    document.body.innerHTML = '<main><button aria-label="safe">old</button></main>';
    const added = document.createElement('section');
    added.innerHTML = '<button aria-label="delete account">new</button>';
    document.querySelector('main')!.appendChild(added);
    const documentScan = vi.spyOn(document, 'querySelectorAll');
    const subtreeScan = vi.spyOn(added, 'querySelectorAll');
    const blocked = new Set<Element>();

    tagBlockedElements(added, ['delete'], blocked);

    expect(documentScan).not.toHaveBeenCalled();
    expect(subtreeScan).toHaveBeenCalledTimes(1);
    expect(blocked).toHaveLength(1);
    expect((added.querySelector('button') as HTMLElement).dataset.perfBlocked).toBe('1');
  });
});
