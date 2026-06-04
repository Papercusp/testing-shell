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

/** One offending element/resource under a finding (distilled from a PSI audit's details.items). */
export interface FindingItem {
  url?: string;
  snippet?: string; // DOM node HTML
  selector?: string; // CSS selector
  label?: string; // node label / human text
  wastedBytes?: number;
  wastedMs?: number;
}

/**
 * A failing/imperfect PSI audit, distilled for an agent to act on: the issue, the
 * fix guidance (`description`), and the specific offending items. This is the
 * actionable layer a bare score lacks.
 */
export interface Finding {
  id: string;
  title: string;
  description: string; // Google's how-to-fix guidance (may contain a markdown link)
  category: string; // 'perf' | 'a11y' | 'bp' | 'seo'
  score: number | null; // audit score 0–1
  displayValue: string;
  savingsMs: number | null;
  items: FindingItem[];
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
  /** Prioritized failing audits + their offending items — the agent-actionable layer. */
  findings: Finding[];
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

function kb(bytes?: number): string {
  return typeof bytes === 'number' ? `${Math.round(bytes / 1024)} KB` : '';
}

/** First sentence of an audit description (drops the rest; keeps any trailing markdown link). */
function firstSentence(desc: string): string {
  if (!desc) return '';
  const cut = desc.split(/(?<=\.)\s/)[0];
  return cut.length < desc.length ? cut : desc;
}

/**
 * Render a PageSpeed summary's findings as a compact, prioritized, ready-to-paste
 * markdown fix-list for a coding agent: each finding's title, fix guidance, and the
 * specific offending resources/elements, biggest-impact first. Hand this (or the
 * whole summary) to an agent; pair it with the repo + a re-run to close the loop.
 */
export function formatFindingsMarkdown(summary: PageSpeedSummary): string {
  const lines: string[] = [];
  const c = summary.categories;
  lines.push(`# PageSpeed findings — ${summary.finalUrl} (${summary.strategy})`);
  lines.push(
    `Scores: Performance ${c.performance ?? '—'} · Accessibility ${c.accessibility ?? '—'} · Best Practices ${c.bestPractices ?? '—'} · SEO ${c.seo ?? '—'}`,
  );
  const m = summary.metrics;
  lines.push(`Lab: LCP ${m.lcp.displayValue} · CLS ${m.cls.displayValue} · TBT ${m.tbt.displayValue} · Speed Index ${m.speedIndex.displayValue}`);
  lines.push('');
  if (!summary.findings?.length) {
    lines.push('_No failing audits captured._');
    return lines.join('\n');
  }
  lines.push(`## Issues to fix (${summary.findings.length}, highest-impact first)`);
  for (const f of summary.findings) {
    const savings = f.savingsMs ? ` — est. savings ${Math.round(f.savingsMs)} ms` : '';
    const dv = f.displayValue ? ` (${f.displayValue})` : '';
    lines.push('');
    lines.push(`### [${f.category}] ${f.title}${savings}${dv}`);
    if (f.description) lines.push(firstSentence(f.description));
    for (const it of f.items) {
      const bits = [
        it.url,
        it.selector && !it.url ? `\`${it.selector}\`` : '',
        it.label && !it.url ? it.label : '',
        kb(it.wastedBytes) && `${kb(it.wastedBytes)} wasted`,
        typeof it.wastedMs === 'number' ? `${Math.round(it.wastedMs)} ms` : '',
      ].filter(Boolean);
      if (bits.length) lines.push(`- ${bits.join(' · ')}`);
      else if (it.snippet) lines.push(`- \`${it.snippet.slice(0, 120)}\``);
    }
  }
  return lines.join('\n');
}
