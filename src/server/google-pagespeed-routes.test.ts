import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGooglePageSpeedHonoRoutes } from './google-pagespeed-routes';
import type { PageSpeedStore, PageSpeedRecord, PageSpeedSummary } from './google-pagespeed';

const raw = JSON.parse(readFileSync(join(__dirname, '__fixtures__/psi-fixture.json'), 'utf-8'));

function memStore() {
  const rows: PageSpeedRecord[] = [];
  let n = 0;
  const store: PageSpeedStore = {
    async save(summary: PageSpeedSummary, meta) {
      const rec: PageSpeedRecord = {
        ...summary,
        id: `id${++n}`,
        project: meta.project ?? null,
        createdAt: `2026-06-03T0${n}:00:00Z`,
      };
      rows.unshift(rec);
      return rec;
    },
    async list({ url, strategy }) {
      return rows.filter((r) => (!url || r.requestedUrl === url) && (!strategy || r.strategy === strategy));
    },
    async get(id) {
      return rows.find((r) => r.id === id) ?? null;
    },
    async listUrls() {
      const seen = new Map<string, { url: string; count: number; lastRunAt: string }>();
      for (const r of rows) {
        const e = seen.get(r.requestedUrl) ?? { url: r.requestedUrl, count: 0, lastRunAt: r.createdAt };
        e.count += 1;
        seen.set(r.requestedUrl, e);
      }
      return [...seen.values()];
    },
  };
  return { store, rows };
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(raw), { status: 200 })));
});

describe('createGooglePageSpeedHonoRoutes', () => {
  it('POST /run rejects a non-public url with 400', async () => {
    const app = createGooglePageSpeedHonoRoutes();
    const res = await app.request('/run', { method: 'POST', body: JSON.stringify({ url: 'http://localhost:4321' }) });
    expect(res.status).toBe(400);
  });

  it('POST /run runs, saves via the store, returns { id, summary }', async () => {
    const { store, rows } = memStore();
    const app = createGooglePageSpeedHonoRoutes({ store, resolveProject: () => 'restart' });
    const res = await app.request('/run', { method: 'POST', body: JSON.stringify({ url: 'https://shop.buyrestart.com' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe('id1');
    expect(body.summary.categories.performance).toBe(80);
    expect(rows[0].project).toBe('restart');
  });

  it('POST /run returns 200 with id=null when the store throws (best-effort persist)', async () => {
    const store: PageSpeedStore = {
      save: async () => {
        throw new Error('db down');
      },
      list: async () => [],
      get: async () => null,
      listUrls: async () => [],
    };
    const app = createGooglePageSpeedHonoRoutes({ store });
    const res = await app.request('/run', { method: 'POST', body: JSON.stringify({ url: 'https://shop.buyrestart.com' }) });
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBeNull();
  });

  it('POST /run returns 502 with the API error when PSI fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Quota exceeded' } }), { status: 429 })));
    const app = createGooglePageSpeedHonoRoutes();
    const res = await app.request('/run', { method: 'POST', body: JSON.stringify({ url: 'https://shop.buyrestart.com' }) });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/429.*Quota exceeded/);
  });

  it('GET /results returns saved rows; /results/:id fetches one', async () => {
    const { store } = memStore();
    const app = createGooglePageSpeedHonoRoutes({ store });
    await app.request('/run', { method: 'POST', body: JSON.stringify({ url: 'https://shop.buyrestart.com' }) });
    const list = await (await app.request('/results?url=https://shop.buyrestart.com/')).json();
    expect(list.results.length).toBe(1);
    const one = await (await app.request(`/results/${list.results[0].id}`)).json();
    expect(one.id).toBe(list.results[0].id);
  });

  it('GET /urls returns distinct URLs for the selector', async () => {
    const { store } = memStore();
    const app = createGooglePageSpeedHonoRoutes({ store });
    await app.request('/run', { method: 'POST', body: JSON.stringify({ url: 'https://shop.buyrestart.com' }) });
    const urls = await (await app.request('/urls')).json();
    expect(urls.urls[0].url).toBe('https://shop.buyrestart.com/');
    expect(urls.urls[0].count).toBe(1);
  });

  it('GET /results + /urls return empty when no store is configured', async () => {
    const app = createGooglePageSpeedHonoRoutes();
    expect((await (await app.request('/results')).json()).results).toEqual([]);
    expect((await (await app.request('/urls')).json()).urls).toEqual([]);
  });
});
