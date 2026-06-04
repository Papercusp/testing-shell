import { describe, it, expect } from 'vitest';
import { createClaudeSeoHonoRoutes } from './claude-seo-routes';
import type { ClaudeSeoStore, SeoReport } from './claude-seo';

const enc = new TextEncoder();
/** A canned SSE source like spawnClaudeSeoStream would emit. */
function fakeRun(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(enc.encode('event: log\ndata: {"line":"Analyzing…"}\n\n'));
      c.enqueue(enc.encode('event: report\ndata: {"report":"# SEO\\nOverall Score: 73/100"}\n\n'));
      c.enqueue(enc.encode('event: done\ndata: {"score":73,"isError":false}\n\n'));
      c.close();
    },
  });
}

function memStore() {
  const rows: SeoReport[] = [];
  let n = 0;
  const store: ClaudeSeoStore = {
    async save(r, meta) {
      const rec: SeoReport = { ...r, id: `id${++n}`, project: meta.project ?? null, createdAt: `2026-06-04T0${n}:00:00Z` };
      rows.unshift(rec);
      return rec;
    },
    async list({ url, command }) {
      return rows.filter((r) => (!url || r.url === url) && (!command || r.command === command));
    },
    async get(id) {
      return rows.find((r) => r.id === id) ?? null;
    },
    async listUrls() {
      const seen = new Map<string, { url: string; count: number; lastRunAt: string }>();
      for (const r of rows) {
        const e = seen.get(r.url) ?? { url: r.url, count: 0, lastRunAt: r.createdAt };
        e.count += 1;
        seen.set(r.url, e);
      }
      return [...seen.values()];
    },
  };
  return { store, rows };
}

async function readBody(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let s = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    s += dec.decode(value);
  }
  return s;
}

describe('createClaudeSeoHonoRoutes', () => {
  it('POST /run rejects an unknown command (400) and localhost', async () => {
    const app = createClaudeSeoHonoRoutes({ homeDir: '/iso', runStream: fakeRun });
    expect((await app.request('/run', { method: 'POST', body: JSON.stringify({ command: 'nope', url: 'https://x.com' }) })).status).toBe(400);
    expect((await app.request('/run', { method: 'POST', body: JSON.stringify({ command: 'page', url: 'http://localhost' }) })).status).toBe(400);
  });

  it('POST /run streams frames + persists the report on flush (saved frame + store.save)', async () => {
    const { store, rows } = memStore();
    const app = createClaudeSeoHonoRoutes({ homeDir: '/iso', store, runStream: fakeRun, resolveProject: () => 'restart' });
    const res = await app.request('/run', { method: 'POST', body: JSON.stringify({ command: 'page', url: 'https://shop.buyrestart.com' }) });
    expect(res.status).toBe(200);
    const body = await readBody(res);
    expect(body).toContain('event: report');
    expect(body).toContain('event: saved');
    expect(rows).toHaveLength(1);
    expect(rows[0].score).toBe(73);
    expect(rows[0].command).toBe('page');
    expect(rows[0].project).toBe('restart');
  });

  it('POST /run returns 503 when the runner is not available', async () => {
    const app = createClaudeSeoHonoRoutes({ homeDir: '/iso', runStream: fakeRun, isAvailable: () => false });
    const res = await app.request('/run', { method: 'POST', body: JSON.stringify({ command: 'page', url: 'https://x.com' }) });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/not configured/i);
  });

  it('GET /results + /results/:id + /urls', async () => {
    const { store } = memStore();
    const app = createClaudeSeoHonoRoutes({ homeDir: '/iso', store, runStream: fakeRun });
    await readBody(await app.request('/run', { method: 'POST', body: JSON.stringify({ command: 'page', url: 'https://shop.buyrestart.com' }) })); // drain → flush persists
    const list = await (await app.request('/results?url=https://shop.buyrestart.com/&command=page')).json();
    expect(list.results).toHaveLength(1);
    const one = await (await app.request(`/results/${list.results[0].id}`)).json();
    expect(one.id).toBe(list.results[0].id);
    const urls = await (await app.request('/urls')).json();
    expect(urls.urls[0].count).toBe(1);
  });

  it('GET /results + /urls return empty with no store', async () => {
    const app = createClaudeSeoHonoRoutes({ homeDir: '/iso', runStream: fakeRun });
    expect((await (await app.request('/results')).json()).results).toEqual([]);
    expect((await (await app.request('/urls')).json()).urls).toEqual([]);
  });
});
