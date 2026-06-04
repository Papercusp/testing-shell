/**
 * Hono convenience router for the Claude SEO domain. Behind its own subpath
 * export so the server barrel never imports the optional `hono` peer.
 *
 *   POST /run         { command, url } → SSE (log/report/done/error/saved); persists on done (best-effort)
 *   GET  /results     ?url=&command=&limit= → { results }
 *   GET  /results/:id → SeoReport | 404
 *   GET  /urls        ?limit= → { urls }
 */
import { Hono, type Context } from 'hono';
import {
  parseClaudeSeoConfig,
  spawnClaudeSeoStream,
  type ClaudeSeoConfig,
  type ClaudeSeoRunOpts,
  type ClaudeSeoStore,
  type SeoCommand,
} from './claude-seo';

export interface ClaudeSeoRoutesConfig {
  /** Isolated HOME with the claude-seo plugin + symlinked login. */
  homeDir: string;
  getClaudeBin?: () => string | undefined;
  cwd?: string;
  timeoutMs?: number;
  /** Returns false when the runner can't run here (e.g. prod, no login) → /run 503s clearly. */
  isAvailable?: () => boolean;
  store?: ClaudeSeoStore;
  resolveProject?: (c: Context) => string | null;
  defaultUrl?: string;
  defaultCommand?: SeoCommand;
  /** Test seam — defaults to spawnClaudeSeoStream. */
  runStream?: (cfg: ClaudeSeoConfig, opts: ClaudeSeoRunOpts) => ReadableStream<Uint8Array>;
}

const enc = new TextEncoder();
const SSE_HEADERS = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' };

function clampLimit(raw: string | undefined, fallback: number): number {
  return Math.min(Math.max(parseInt(raw ?? String(fallback), 10) || fallback, 1), 100);
}

export function createClaudeSeoHonoRoutes(cfg: ClaudeSeoRoutesConfig): Hono {
  const app = new Hono();
  const run = cfg.runStream ?? spawnClaudeSeoStream;

  app.post('/run', async (c) => {
    if (cfg.isAvailable && !cfg.isAvailable()) {
      return c.json({ error: 'Claude SEO runner is not configured on this host (needs a Claude Code login + the claude-seo plugin).' }, 503);
    }
    const body = await c.req.json().catch(() => null);
    const parsed = parseClaudeSeoConfig(body, { defaultUrl: cfg.defaultUrl, defaultCommand: cfg.defaultCommand });
    if (!parsed.ok) return c.json({ error: parsed.msg }, 400);

    const project = cfg.resolveProject?.(c) ?? null;
    const source = run(parsed.cfg, {
      homeDir: cfg.homeDir,
      claudeBin: cfg.getClaudeBin?.(),
      cwd: cfg.cwd,
      timeoutMs: cfg.timeoutMs,
    });

    // Tee: forward frames to the client unchanged, capture report+score, persist on flush.
    let reportText = '';
    let score: number | null = null;
    const dec = new TextDecoder();
    let buf = '';
    const tee = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        buf += dec.decode(chunk, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop() ?? '';
        for (const f of parts) {
          const ev = f.split('\n').find((l) => l.startsWith('event: '))?.slice(7);
          const dt = f.split('\n').find((l) => l.startsWith('data: '))?.slice(6);
          if (!ev || !dt) continue;
          try {
            const data = JSON.parse(dt) as Record<string, unknown>;
            if (ev === 'report' && typeof data.report === 'string') reportText = data.report;
            if (ev === 'done' && typeof data.score === 'number') score = data.score;
          } catch {
            /* partial/non-json */
          }
        }
      },
      async flush(controller) {
        if (cfg.store && reportText) {
          try {
            const rec = await cfg.store.save({ url: parsed.cfg.url, command: parsed.cfg.command, score, report: reportText }, { project });
            controller.enqueue(enc.encode(`event: saved\ndata: ${JSON.stringify({ id: rec.id })}\n\n`));
          } catch {
            /* best-effort persist */
          }
        }
      },
    });

    return new Response(source.pipeThrough(tee), { headers: SSE_HEADERS });
  });

  app.get('/results', async (c) => {
    if (!cfg.store) return c.json({ results: [] });
    const project = cfg.resolveProject?.(c) ?? null;
    const url = c.req.query('url') || undefined;
    const command = c.req.query('command') || undefined;
    const limit = clampLimit(c.req.query('limit'), 20);
    return c.json({ results: await cfg.store.list({ project, url, command, limit }) });
  });

  app.get('/results/:id', async (c) => {
    if (!cfg.store) return c.json({ error: 'no store configured' }, 404);
    const rec = await cfg.store.get(c.req.param('id'));
    if (!rec) return c.json({ error: 'not found' }, 404);
    return c.json(rec);
  });

  app.get('/urls', async (c) => {
    if (!cfg.store) return c.json({ urls: [] });
    const project = cfg.resolveProject?.(c) ?? null;
    const limit = clampLimit(c.req.query('limit'), 100);
    return c.json({ urls: await cfg.store.listUrls({ project, limit }) });
  });

  return app;
}
