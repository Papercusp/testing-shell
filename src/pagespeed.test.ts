import { describe, it, expect } from 'vitest';
import { computeMetricDeltas, METRIC_POLARITY, type PageSpeedSummary } from './pagespeed';

function summary(over: { categories?: Partial<PageSpeedSummary['categories']>; metrics?: Partial<Record<keyof PageSpeedSummary['metrics'], number | null>> } = {}): PageSpeedSummary {
  const lab = (numericValue: number | null) => ({ numericValue, displayValue: String(numericValue) });
  return {
    requestedUrl: 'https://shop.buyrestart.com/',
    finalUrl: 'https://shop.buyrestart.com/',
    strategy: 'mobile',
    fetchedAt: '2026-06-03T00:00:00Z',
    categories: { performance: 80, accessibility: 95, bestPractices: 100, seo: 92, ...over.categories },
    metrics: {
      lcp: lab(over.metrics?.lcp ?? 4000),
      fcp: lab(over.metrics?.fcp ?? 1600),
      cls: lab(over.metrics?.cls ?? 0.1),
      tbt: lab(over.metrics?.tbt ?? 350),
      speedIndex: lab(over.metrics?.speedIndex ?? 4000),
      tti: lab(over.metrics?.tti ?? 5000),
    },
    fieldData: null,
    opportunities: [],
    reportUrl: 'https://pagespeed.web.dev/analysis?url=x&form_factor=mobile',
  };
}

describe('METRIC_POLARITY', () => {
  it('scores are higher-better, lab metrics are lower-better', () => {
    expect(METRIC_POLARITY.performance).toBe('higher-better');
    expect(METRIC_POLARITY.seo).toBe('higher-better');
    expect(METRIC_POLARITY.lcp).toBe('lower-better');
    expect(METRIC_POLARITY.cls).toBe('lower-better');
  });
});

describe('computeMetricDeltas', () => {
  it('returns hasPrev=false / nulls when there is no previous report', () => {
    const d = computeMetricDeltas(summary(), null);
    expect(d.performance).toEqual({ value: null, percent: null, improved: null, hasPrev: false });
    expect(d.lcp.hasPrev).toBe(false);
  });

  it('marks a higher score as improved (green) with a positive % ', () => {
    const cur = summary({ categories: { performance: 85 } });
    const prev = summary({ categories: { performance: 80 } });
    const d = computeMetricDeltas(cur, prev).performance;
    expect(d.value).toBe(5);
    expect(d.percent).toBeCloseTo(6.25, 5);
    expect(d.improved).toBe(true);
    expect(d.hasPrev).toBe(true);
  });

  it('marks a lower score as regressed (red)', () => {
    const d = computeMetricDeltas(summary({ categories: { seo: 80 } }), summary({ categories: { seo: 92 } })).seo;
    expect(d.value).toBe(-12);
    expect(d.improved).toBe(false);
  });

  it('treats a FASTER lab metric (lower value) as improved', () => {
    const cur = summary({ metrics: { lcp: 3000 } });
    const prev = summary({ metrics: { lcp: 4000 } });
    const d = computeMetricDeltas(cur, prev).lcp;
    expect(d.value).toBe(-1000);
    expect(d.percent).toBeCloseTo(-25, 5);
    expect(d.improved).toBe(true); // lower-better
  });

  it('treats a SLOWER lab metric (higher value) as regressed', () => {
    const d = computeMetricDeltas(summary({ metrics: { lcp: 4000 } }), summary({ metrics: { lcp: 3000 } })).lcp;
    expect(d.value).toBe(1000);
    expect(d.improved).toBe(false);
  });

  it('returns percent=null when the previous value is 0 (e.g. CLS)', () => {
    const d = computeMetricDeltas(summary({ metrics: { cls: 0.05 } }), summary({ metrics: { cls: 0 } })).cls;
    expect(d.value).toBeCloseTo(0.05, 5);
    expect(d.percent).toBeNull();
    expect(d.improved).toBe(false); // CLS rose ⇒ worse
    expect(d.hasPrev).toBe(true);
  });

  it('marks an unchanged metric as improved=null', () => {
    const d = computeMetricDeltas(summary(), summary()).performance;
    expect(d.value).toBe(0);
    expect(d.improved).toBeNull();
  });
});
