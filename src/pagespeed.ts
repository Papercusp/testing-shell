/**
 * Google PageSpeed — shared, React-free, Node-free types + the pure
 * per-metric delta math. Imported by BOTH the server core
 * (`server/google-pagespeed.ts`) and the web panel
 * (`web/GooglePageSpeedPanel.tsx`), so it must stay free of `fetch`/`node:*`/
 * React (mirrors how `k6.ts` holds the React-free k6 taxonomy the panel reuses).
 */

export type PageSpeedStrategy = 'mobile' | 'desktop';

export interface CategoryScores {
  performance: number | null;
  accessibility: number | null;
  bestPractices: number | null;
  seo: number | null;
}

export interface LabMetric {
  /** Raw numeric value (ms, or unitless for CLS); null if absent. */
  numericValue: number | null;
  /** Human display string, e.g. "2.3 s". */
  displayValue: string;
}

export interface LabMetrics {
  lcp: LabMetric;
  fcp: LabMetric;
  cls: LabMetric;
  tbt: LabMetric;
  speedIndex: LabMetric;
  tti: LabMetric;
}

export interface FieldMetric {
  percentile: number | null;
  category: 'FAST' | 'AVERAGE' | 'SLOW' | null;
}

export interface FieldData {
  overallCategory: 'FAST' | 'AVERAGE' | 'SLOW' | null;
  lcp: FieldMetric;
  inp: FieldMetric;
  cls: FieldMetric;
  fcp: FieldMetric;
}

export interface Opportunity {
  id: string;
  title: string;
  displayValue: string;
  savingsMs: number | null;
}

export interface PageSpeedSummary {
  requestedUrl: string;
  finalUrl: string;
  strategy: PageSpeedStrategy;
  fetchedAt: string;
  categories: CategoryScores;
  metrics: LabMetrics;
  fieldData: FieldData | null;
  opportunities: Opportunity[];
  reportUrl: string;
}

/** A persisted summary — the store adds id/project/createdAt. */
export interface PageSpeedRecord extends PageSpeedSummary {
  id: string;
  project: string | null;
  createdAt: string;
}

// ─── Per-metric deltas ───────────────────────────────────────────────────────

export type MetricKey =
  | 'performance'
  | 'accessibility'
  | 'bestPractices'
  | 'seo'
  | 'lcp'
  | 'fcp'
  | 'cls'
  | 'tbt'
  | 'speedIndex'
  | 'tti';

/**
 * Whether a higher value is better (the four Lighthouse category scores) or a
 * lower value is better (every lab timing/shift metric). Drives the green/red
 * direction independent of which way the raw number moved.
 */
export const METRIC_POLARITY: Record<MetricKey, 'higher-better' | 'lower-better'> = {
  performance: 'higher-better',
  accessibility: 'higher-better',
  bestPractices: 'higher-better',
  seo: 'higher-better',
  lcp: 'lower-better',
  fcp: 'lower-better',
  cls: 'lower-better',
  tbt: 'lower-better',
  speedIndex: 'lower-better',
  tti: 'lower-better',
};

/** Stable display order for the metric rows + badges. */
export const METRIC_KEYS = Object.keys(METRIC_POLARITY) as MetricKey[];

export interface MetricDelta {
  /** current − previous (raw value); null when not comparable. */
  value: number | null;
  /** Relative % change `(current − previous) / |previous| × 100`; null when no prior or previous is 0. */
  percent: number | null;
  /** true = better than the previous report, false = worse, null = unchanged / not comparable. */
  improved: boolean | null;
  /** Whether a previous report existed to compare against. */
  hasPrev: boolean;
}

function metricValue(s: PageSpeedSummary, key: MetricKey): number | null {
  switch (key) {
    case 'performance':
      return s.categories.performance;
    case 'accessibility':
      return s.categories.accessibility;
    case 'bestPractices':
      return s.categories.bestPractices;
    case 'seo':
      return s.categories.seo;
    default:
      return s.metrics[key].numericValue;
  }
}

/**
 * Compare every metric of `current` to `previous` (the previous report for the
 * SAME url + strategy). Returns one {@link MetricDelta} per metric. With no
 * previous report every entry is `{ hasPrev:false, … null }`. `percent` is null
 * when the previous value is 0 (e.g. CLS), where a relative change is undefined.
 */
export function computeMetricDeltas(
  current: PageSpeedSummary,
  previous: PageSpeedSummary | null,
): Record<MetricKey, MetricDelta> {
  const out = {} as Record<MetricKey, MetricDelta>;
  const hasPrev = previous != null;
  for (const key of METRIC_KEYS) {
    const cur = metricValue(current, key);
    const prev = previous ? metricValue(previous, key) : null;
    if (!hasPrev || cur == null || prev == null) {
      out[key] = { value: null, percent: null, improved: null, hasPrev };
      continue;
    }
    const value = cur - prev;
    const percent = prev !== 0 ? (value / Math.abs(prev)) * 100 : null;
    const improved =
      value === 0 ? null : METRIC_POLARITY[key] === 'higher-better' ? value > 0 : value < 0;
    out[key] = { value, percent, improved, hasPrev };
  }
  return out;
}
