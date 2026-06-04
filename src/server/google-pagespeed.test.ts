import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parsePageSpeedConfig,
  summarizePageSpeed,
  runPageSpeed,
  isPubliclyFetchable,
} from './google-pagespeed';

const raw = JSON.parse(readFileSync(join(__dirname, '__fixtures__/psi-fixture.json'), 'utf-8'));

describe('parsePageSpeedConfig', () => {
  it('defaults strategy to mobile and uses defaultUrl', () => {
    const r = parsePageSpeedConfig({}, { defaultUrl: 'https://shop.buyrestart.com' });
    expect(r).toEqual({ ok: true, cfg: { url: 'https://shop.buyrestart.com/', strategy: 'mobile' } });
  });
  it('honors an explicit desktop strategy', () => {
    const r = parsePageSpeedConfig({ url: 'https://x.com', strategy: 'desktop' });
    expect(r.ok && r.cfg.strategy).toBe('desktop');
  });
  it('rejects localhost (Google cannot reach it)', () => {
    expect(parsePageSpeedConfig({ url: 'http://localhost:4321' }).ok).toBe(false);
  });
  it('rejects an invalid strategy', () => {
    expect(parsePageSpeedConfig({ url: 'https://x.com', strategy: 'foo' }).ok).toBe(false);
  });
  it('requires a url when no default', () => {
    expect(parsePageSpeedConfig({}).ok).toBe(false);
  });
});

describe('isPubliclyFetchable', () => {
  it('accepts an https public host', () => {
    expect(isPubliclyFetchable(new URL('https://shop.buyrestart.com'))).toBe(true);
  });
  it('rejects private + loopback ranges', () => {
    expect(isPubliclyFetchable(new URL('http://192.168.1.5'))).toBe(false);
    expect(isPubliclyFetchable(new URL('http://10.0.0.1'))).toBe(false);
    expect(isPubliclyFetchable(new URL('http://127.0.0.1'))).toBe(false);
    expect(isPubliclyFetchable(new URL('http://172.16.0.9'))).toBe(false);
  });
});

describe('summarizePageSpeed', () => {
  const s = summarizePageSpeed(raw, 'mobile');
  it('extracts the 4 category scores as 0-100 ints', () => {
    expect(s.categories).toEqual({ performance: 80, accessibility: 95, bestPractices: 100, seo: 92 });
  });
  it('extracts lab metric numeric + display values', () => {
    expect(s.metrics.lcp).toEqual({ numericValue: 3800.5, displayValue: '3.8 s' });
    expect(s.metrics.cls.displayValue).toBe('0');
    expect(s.metrics.tti.numericValue).toBe(5000);
  });
  it('extracts CrUX field data', () => {
    expect(s.fieldData?.overallCategory).toBe('AVERAGE');
    expect(s.fieldData?.lcp).toEqual({ percentile: 3200, category: 'AVERAGE' });
    expect(s.fieldData?.inp.category).toBe('FAST');
  });
  it('keeps only opportunity audits, sorted by savings desc, capped at 5', () => {
    expect(s.opportunities.map((o) => o.id)).toEqual([
      'uses-optimized-images',
      'render-blocking-resources',
      'unused-javascript',
    ]);
    expect(s.opportunities[0].savingsMs).toBe(2100);
  });
  it('builds a PSI report deep link for the strategy', () => {
    expect(s.reportUrl).toContain('pagespeed.web.dev');
    expect(s.reportUrl).toContain('form_factor=mobile');
  });
  it('carries the analysis timestamp + final URL', () => {
    expect(s.fetchedAt).toBe('2026-06-03T12:00:00.000Z');
    expect(s.finalUrl).toBe('https://shop.buyrestart.com/');
  });
});

describe('runPageSpeed', () => {
  it('calls PSI with strategy + categories + key and returns a summary', async () => {
    const fetchImpl = vi.fn(async (u: string) => {
      expect(u).toContain('runPagespeed');
      expect(u).toContain('strategy=mobile');
      expect(u).toContain('category=performance');
      expect(u).toContain('key=TESTKEY');
      return new Response(JSON.stringify(raw), { status: 200 });
    }) as unknown as typeof fetch;
    const s = await runPageSpeed(
      { url: 'https://shop.buyrestart.com/pricing', strategy: 'mobile' },
      { apiKey: 'TESTKEY', fetchImpl },
    );
    expect(s.categories.performance).toBe(80);
    // requestedUrl is forced to the canonical cfg.url (not PSI's echoed id) so it's a stable history key.
    expect(s.requestedUrl).toBe('https://shop.buyrestart.com/pricing');
  });

  it('throws with the API error message on a non-200 (e.g. 429 quota)', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { message: 'Quota exceeded' } }), {
        status: 429,
      })) as unknown as typeof fetch;
    await expect(
      runPageSpeed({ url: 'https://x.com', strategy: 'mobile' }, { fetchImpl }),
    ).rejects.toThrow(/429.*Quota exceeded/);
  });
});
