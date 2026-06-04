/**
 * Hono convenience router for the Google PageSpeed domain — mirrors
 * `createK6HonoRoutes`. Behind its own subpath export so the server barrel never
 * imports the optional `hono` peer.
 *
 *   POST /run            { url, strategy } → { id, summary }   (validates + runs PSI, best-effort persist)
 *   GET  /results        ?url=&strategy=&limit= → { results }  (history; [] when no store)
 *   GET  /results/:id    → PageSpeedRecord | 404
 *   GET  /urls           ?limit= → { urls: [{ url, count, lastRunAt }] }  (the URL selector)
 */
import { Hono, type Context } from 'hono';
import {
  parsePageSpeedConfig,
  runPageSpeed,
  type PageSpeedStore,
  type PageSpeedStrategy,
} from './google-pagespeed';

export interface GooglePageSpeedRoutesConfig {
  /** Optional PSI API key (the PageSpeed Insights API must be enabled on it). */
  getApiKey?: () => string | undefined;
  /** Optional persistence — the consumer's DB-backed store. Omit → runs aren't saved. */
  store?: PageSpeedStore;
  /** Per-request project tag (e.g. from ?project=). */
  resolveProject?: (c: Context) => string | null;
  defaultUrl?: string;
  defaultStrategy?: PageSpeedStrategy;
}

function clampLimit(raw: string | undefined, fallback: number): number {
  return Math.min(Math.max(parseInt(raw ?? String(fallback), 10) || fallback, 1), 100);
}

export function createGooglePageSpeedHonoRoutes(cfg: GooglePageSpeedRoutesConfig = {}): Hono {
  const app = new Hono();

  app.post('/run', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = parsePageSpeedConfig(body, {
      defaultUrl: cfg.defaultUrl,
      defaultStrategy: cfg.defaultStrategy,
    });
    if (!parsed.ok) return c.json({ error: parsed.msg }, 400);

    let summary;
    try {
      summary = await runPageSpeed(parsed.cfg, { apiKey: cfg.getApiKey?.() });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
    }

    const project = cfg.resolveProject?.(c) ?? null;
    let id: string | null = null;
    if (cfg.store) {
      try {
        id = (await cfg.store.save(summary, { project })).id;
      } catch {
        /* persistence is best-effort — never fail the run on a save error */
      }
    }
    return c.json({ id, summary });
  });

  app.get('/results', async (c) => {
    if (!cfg.store) return c.json({ results: [] });
    const project = cfg.resolveProject?.(c) ?? null;
    const url = c.req.query('url') || undefined;
    const rawStrategy = c.req.query('strategy');
    const strategy =
      rawStrategy === 'mobile' || rawStrategy === 'desktop' ? rawStrategy : undefined;
    const limit = clampLimit(c.req.query('limit'), 20);
    return c.json({ results: await cfg.store.list({ project, url, strategy, limit }) });
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
