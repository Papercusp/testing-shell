import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./k6', () => ({
  K6_ID_RE: /^[a-z0-9-]+$/,
  listK6Scripts: vi.fn(() => [{ id: 'smoke', name: 'Smoke', description: '', category: 'smoke', estimatedDuration: '30s', defaultVUs: 2 }]),
  listK6Results: vi.fn(() => [{ id: 'r1', scriptId: 'smoke', scriptName: 'Smoke', startedAt: '2026-06-01T00:00:00Z', exitCode: 0, log: [] }]),
  getK6Result: vi.fn((_dir: string, id: string) => (id === 'r1' ? { id: 'r1', scriptId: 'smoke', scriptName: 'Smoke', startedAt: '2026-06-01T00:00:00Z', exitCode: 0, log: [] } : null)),
  runK6Stream: vi.fn(() => new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"type":"done","code":0}\n\n')); c.close(); } })),
  stopK6: vi.fn(() => true),
}));

import { createK6HonoRoutes } from './k6-routes';
import { listK6Scripts, runK6Stream } from './k6';

const resolvePaths = () => ({ repoRoot: '/repo', scriptsDir: '/s', resultsDir: '/r' });
let app: ReturnType<typeof createK6HonoRoutes>;

beforeEach(() => {
  vi.clearAllMocks();
  app = createK6HonoRoutes({ k6Bin: '/bin/k6', resolvePaths });
});

describe('createK6HonoRoutes', () => {
  it('GET /scripts returns the script list', async () => {
    const res = await app.request('/scripts?project=restart');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ scripts: [expect.objectContaining({ id: 'smoke' })] });
    expect(vi.mocked(listK6Scripts)).toHaveBeenCalledWith('/s');
  });

  it('POST /run rejects a missing/invalid scriptId with 400', async () => {
    const bad = await app.request('/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
    expect(bad.status).toBe(400);
    const traversal = await app.request('/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scriptId: '../x' }) });
    expect(traversal.status).toBe(400);
    expect(vi.mocked(runK6Stream)).not.toHaveBeenCalled();
  });

  it('POST /run streams for a valid scriptId', async () => {
    const res = await app.request('/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scriptId: 'smoke', vus: 5 }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(await res.text()).toContain('"type":"done"');
    expect(vi.mocked(runK6Stream)).toHaveBeenCalledWith(expect.objectContaining({ scriptId: 'smoke', vus: 5, k6Bin: '/bin/k6' }));
  });

  it('GET /results/:id 404s for an unknown id', async () => {
    expect((await app.request('/results/r1')).status).toBe(200);
    expect((await app.request('/results/nope')).status).toBe(404);
  });

  it('POST /stop returns ok', async () => {
    expect(await (await app.request('/stop', { method: 'POST' })).json()).toEqual({ ok: true });
  });
});
