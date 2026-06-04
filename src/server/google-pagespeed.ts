/**
 * Google PageSpeed Insights (Lighthouse) backend core.
 *
 * Framework-agnostic — NO React, NO Hono, NO DB. The consumer injects the
 * optional API key + a PageSpeedStore, so the lib stays portable — mirroring
 * how k6 takes `resolvePaths` and <DomainTestPanel> takes a TestingDataSource.
 *
 * Shared wire types + the delta math live in `../pagespeed` (React-/Node-free)
 * and are re-exported here so `@papercusp/testing-shell/server` consumers (e.g.
 * Restart's Drizzle store) get them from one place.
 */
import type {
  FieldData,
  FieldMetric,
  LabMetric,
  Opportunity,
  PageSpeedStrategy,
  PageSpeedSummary,
} from '../pagespeed';

export type {
  PageSpeedStrategy,
  PageSpeedSummary,
  PageSpeedRecord,
  CategoryScores,
  LabMetric,
  LabMetrics,
  FieldData,
  FieldMetric,
  Opportunity,
} from '../pagespeed';

export interface PageSpeedConfig {
  url: string;
  strategy: PageSpeedStrategy;
}

/**
 * Storage seam — the consumer (e.g. Restart's Postgres) supplies this. Omit it
 * and runs still work, just unpersisted. Pure interface ⇒ the lib has no DB dep.
 */
export interface PageSpeedStore {
  save(summary: PageSpeedSummary, meta: { project?: string | null }): Promise<import('../pagespeed').PageSpeedRecord>;
  list(opts: {
    project?: string | null;
    url?: string;
    strategy?: PageSpeedStrategy;
    limit: number;
  }): Promise<import('../pagespeed').PageSpeedRecord[]>;
  get(id: string): Promise<import('../pagespeed').PageSpeedRecord | null>;
  listUrls(opts: { project?: string | null; limit: number }): Promise<
    { url: string; count: number; lastRunAt: string }[]
  >;
}

const PSI_ENDPOINT = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';

/** Reject non-public targets up front — Google's servers must be able to reach the URL. */
export function isPubliclyFetchable(url: URL): boolean {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const h = url.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return false;
  if (h === '127.0.0.1' || h === '::1' || h === '0.0.0.0') return false;
  if (/^10\./.test(h)) return false;
  if (/^192\.168\./.test(h)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
  return true;
}

/** Validate + normalize the request body. Pure. */
export function parsePageSpeedConfig(
  body: unknown,
  opts: { defaultUrl?: string; defaultStrategy?: PageSpeedStrategy } = {},
): { ok: true; cfg: PageSpeedConfig } | { ok: false; msg: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const rawUrl = typeof b.url === 'string' && b.url.trim() ? b.url.trim() : opts.defaultUrl;
  if (!rawUrl) return { ok: false, msg: 'url is required' };
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, msg: `invalid url: ${rawUrl}` };
  }
  if (!isPubliclyFetchable(url)) {
    return {
      ok: false,
      msg: `PageSpeed can only test a public URL (Google fetches it) — "${url.hostname}" is not reachable. Use the public site, e.g. https://shop.buyrestart.com`,
    };
  }
  const rawStrategy =
    typeof b.strategy === 'string' ? b.strategy.toLowerCase() : (opts.defaultStrategy ?? 'mobile');
  if (rawStrategy !== 'mobile' && rawStrategy !== 'desktop') {
    return { ok: false, msg: `strategy must be "mobile" or "desktop" (got "${rawStrategy}")` };
  }
  return { ok: true, cfg: { url: url.toString(), strategy: rawStrategy } };
}

function pct(score: number | null | undefined): number | null {
  return typeof score === 'number' ? Math.round(score * 100) : null;
}

function labMetric(audit: unknown): LabMetric {
  const a = audit as { numericValue?: unknown; displayValue?: unknown } | undefined;
  return {
    numericValue: typeof a?.numericValue === 'number' ? a.numericValue : null,
    displayValue: typeof a?.displayValue === 'string' ? a.displayValue : '—',
  };
}

function fieldMetric(metric: unknown): FieldMetric {
  const m = metric as { percentile?: unknown; category?: unknown } | undefined;
  return {
    percentile: typeof m?.percentile === 'number' ? m.percentile : null,
    category: (m?.category as FieldMetric['category']) ?? null,
  };
}

/** Pure: distill the giant PSI v5 JSON into a compact PageSpeedSummary. */
export function summarizePageSpeed(raw: unknown, strategy: PageSpeedStrategy): PageSpeedSummary {
  const r = (raw ?? {}) as Record<string, any>;
  const lr = r.lighthouseResult ?? {};
  const cats = lr.categories ?? {};
  const audits = lr.audits ?? {};
  const requestedUrl = r.id ?? lr.requestedUrl ?? lr.finalUrl ?? '';
  const finalUrl = lr.finalUrl ?? requestedUrl;

  const le = r.loadingExperience;
  const fieldData: FieldData | null = le?.metrics
    ? {
        overallCategory: le.overall_category ?? null,
        lcp: fieldMetric(le.metrics.LARGEST_CONTENTFUL_PAINT_MS),
        inp: fieldMetric(le.metrics.INTERACTION_TO_NEXT_PAINT),
        cls: fieldMetric(le.metrics.CUMULATIVE_LAYOUT_SHIFT_SCORE),
        fcp: fieldMetric(le.metrics.FIRST_CONTENTFUL_PAINT_MS),
      }
    : null;

  const opportunities: Opportunity[] = Object.values<any>(audits)
    .filter(
      (a) =>
        a?.details?.type === 'opportunity' &&
        typeof a?.details?.overallSavingsMs === 'number' &&
        a.details.overallSavingsMs > 0,
    )
    .map((a) => ({
      id: a.id as string,
      title: a.title as string,
      displayValue: (a.displayValue as string) ?? '',
      savingsMs: Math.round(a.details.overallSavingsMs as number),
    }))
    .sort((x, y) => (y.savingsMs ?? 0) - (x.savingsMs ?? 0))
    .slice(0, 5);

  return {
    requestedUrl,
    finalUrl,
    strategy,
    fetchedAt: r.analysisUTCTimestamp ?? new Date().toISOString(),
    categories: {
      performance: pct(cats.performance?.score),
      accessibility: pct(cats.accessibility?.score),
      bestPractices: pct(cats['best-practices']?.score),
      seo: pct(cats.seo?.score),
    },
    metrics: {
      lcp: labMetric(audits['largest-contentful-paint']),
      fcp: labMetric(audits['first-contentful-paint']),
      cls: labMetric(audits['cumulative-layout-shift']),
      tbt: labMetric(audits['total-blocking-time']),
      speedIndex: labMetric(audits['speed-index']),
      tti: labMetric(audits['interactive']),
    },
    fieldData,
    opportunities,
    reportUrl: `https://pagespeed.web.dev/analysis?url=${encodeURIComponent(finalUrl)}&form_factor=${strategy}`,
  };
}

export interface RunPageSpeedOpts {
  apiKey?: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

/** Call the PSI API and return the compact summary. Throws on HTTP/parse error. */
export async function runPageSpeed(
  cfg: PageSpeedConfig,
  opts: RunPageSpeedOpts = {},
): Promise<PageSpeedSummary> {
  const f = opts.fetchImpl ?? fetch;
  const u = new URL(PSI_ENDPOINT);
  u.searchParams.set('url', cfg.url);
  u.searchParams.set('strategy', cfg.strategy);
  for (const cat of ['performance', 'accessibility', 'best-practices', 'seo']) {
    u.searchParams.append('category', cat);
  }
  if (opts.apiKey) u.searchParams.set('key', opts.apiKey);

  const res = await f(u.toString());
  if (!res.ok) {
    let detail = '';
    try {
      const j = (await res.json()) as { error?: { message?: string } };
      detail = j?.error?.message ?? '';
    } catch {
      /* non-json error body */
    }
    throw new Error(`PageSpeed API ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return summarizePageSpeed(await res.json(), cfg.strategy);
}
