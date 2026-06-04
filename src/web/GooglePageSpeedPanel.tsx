import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  computeMetricDeltas,
  type MetricDelta,
  type MetricKey,
  type PageSpeedRecord,
  type PageSpeedStrategy,
  type PageSpeedSummary,
} from '../pagespeed';

export interface GooglePageSpeedPanelProps {
  /** POST { url, strategy } → { id, summary }. */
  runEndpoint: string;
  /** GET → { results: PageSpeedRecord[] } (filterable by ?url=&strategy=). Omit → no history + no deltas. */
  resultsEndpoint?: string;
  /** GET → { urls: { url, count, lastRunAt }[] } — populates the URL selector. Omit → no selector. */
  urlsEndpoint?: string;
  defaultUrl: string;
  defaultStrategy?: PageSpeedStrategy;
}

type RunState = 'idle' | 'running' | 'error';
const STRATEGIES: PageSpeedStrategy[] = ['mobile', 'desktop'];

/** Lighthouse band → color (≥90 green, ≥50 orange, else red). */
function scoreColor(score: number | null): string {
  if (score == null) return '#9ca3af';
  if (score >= 90) return '#0cce6b';
  if (score >= 50) return '#ffa400';
  return '#ff4e42';
}

function join(base: string, params: Record<string, string | undefined>): string {
  const qs = Object.entries(params)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`)
    .join('&');
  if (!qs) return base;
  return `${base}${base.includes('?') ? '&' : '?'}${qs}`;
}

export default function GooglePageSpeedPanel({
  runEndpoint,
  resultsEndpoint,
  urlsEndpoint,
  defaultUrl,
  defaultStrategy = 'mobile',
}: GooglePageSpeedPanelProps) {
  const [url, setUrl] = useState(defaultUrl);
  const [strategy, setStrategy] = useState<PageSpeedStrategy>(defaultStrategy);
  const [runState, setRunState] = useState<RunState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [ranSummary, setRanSummary] = useState<PageSpeedSummary | null>(null);
  const [history, setHistory] = useState<PageSpeedRecord[]>([]);
  const [urls, setUrls] = useState<{ url: string; count: number; lastRunAt: string }[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const loadUrls = useCallback(async () => {
    if (!urlsEndpoint) return;
    try {
      const r = await fetch(urlsEndpoint);
      if (!r.ok) return;
      const d = (await r.json()) as { urls: { url: string; count: number; lastRunAt: string }[] };
      setUrls(d.urls ?? []);
    } catch {
      /* ignore */
    }
  }, [urlsEndpoint]);

  const loadHistory = useCallback(async () => {
    if (!resultsEndpoint) return;
    try {
      const r = await fetch(join(resultsEndpoint, { url, strategy, limit: '20' }));
      if (!r.ok) return;
      const d = (await r.json()) as { results: PageSpeedRecord[] };
      setHistory(d.results ?? []);
    } catch {
      /* ignore */
    }
  }, [resultsEndpoint, url, strategy]);

  useEffect(() => {
    void loadUrls();
  }, [loadUrls]);

  useEffect(() => {
    setSelectedId(null);
    void loadHistory();
  }, [loadHistory]);

  const run = useCallback(async () => {
    setRunState('running');
    setError(null);
    try {
      const r = await fetch(runEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url, strategy }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error ?? `HTTP ${r.status}`);
      setRanSummary(d.summary as PageSpeedSummary);
      setRunState('idle');
      setSelectedId((d.id as string) ?? null);
      await loadHistory();
      void loadUrls();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRunState('error');
    }
  }, [runEndpoint, url, strategy, loadHistory, loadUrls]);

  // The report to display + the previous (same url+strategy) report to diff against.
  const { report, previous } = useMemo(() => {
    const fromHistory = selectedId ? history.find((r) => r.id === selectedId) : history[0];
    const shown: PageSpeedSummary | PageSpeedRecord | null = fromHistory ?? ranSummary ?? null;
    let prev: PageSpeedSummary | null = null;
    if (fromHistory) {
      const idx = history.findIndex((r) => r.id === fromHistory.id);
      prev = idx >= 0 ? (history[idx + 1] ?? null) : null;
    }
    return { report: shown, previous: prev };
  }, [history, selectedId, ranSummary]);

  const deltas = useMemo(() => (report ? computeMetricDeltas(report, previous) : null), [report, previous]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          aria-label="URL to test"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://shop.buyrestart.com"
          style={{ flex: '1 1 320px', padding: '6px 8px' }}
        />
        {urls.length > 0 && (
          <select
            aria-label="Known URLs"
            value={urls.some((u) => u.url === url) ? url : ''}
            onChange={(e) => e.target.value && setUrl(e.target.value)}
          >
            <option value="">— past URLs —</option>
            {urls.map((u) => (
              <option key={u.url} value={u.url}>
                {u.url} ({u.count})
              </option>
            ))}
          </select>
        )}
        <select aria-label="Strategy" value={strategy} onChange={(e) => setStrategy(e.target.value as PageSpeedStrategy)}>
          {STRATEGIES.map((s) => (
            <option key={s} value={s}>
              {s === 'mobile' ? 'Mobile' : 'Desktop'}
            </option>
          ))}
        </select>
        <button type="button" onClick={() => void run()} disabled={runState === 'running'}>
          {runState === 'running' ? 'Running…' : 'Run'}
        </button>
      </div>

      <p style={{ fontSize: 12, color: '#6b7280', margin: 0 }}>
        PageSpeed runs from Google's servers, so the URL must be publicly reachable (not localhost). Deltas compare each
        metric to the previous report for the same URL + strategy.
      </p>

      {runState === 'running' && (
        <div>
          Analyzing {url} ({strategy})… this takes ~15–30s.
        </div>
      )}
      {runState === 'error' && (
        <div role="alert" style={{ color: '#ff4e42' }}>
          Error: {error}
        </div>
      )}

      {report && deltas && runState !== 'running' && <PageSpeedResult summary={report} deltas={deltas} />}

      {resultsEndpoint && history.length > 0 && (
        <div>
          <h4 style={{ margin: '8px 0' }}>Past reports — {url}</h4>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
            {history.map((h) => {
              const active = h.id === (selectedId ?? history[0]?.id);
              return (
                <li key={h.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(h.id)}
                    style={{
                      display: 'flex',
                      gap: 12,
                      alignItems: 'center',
                      width: '100%',
                      textAlign: 'left',
                      padding: '4px 8px',
                      border: 'none',
                      borderLeft: `3px solid ${active ? '#3b82f6' : 'transparent'}`,
                      background: active ? 'rgba(59,130,246,0.08)' : 'transparent',
                      cursor: 'pointer',
                      fontSize: 13,
                    }}
                  >
                    <span style={{ color: scoreColor(h.categories.performance), fontWeight: 700, width: 28 }}>
                      {h.categories.performance ?? '—'}
                    </span>
                    <span style={{ width: 56 }}>{h.strategy}</span>
                    <span style={{ color: '#6b7280' }}>{new Date(h.createdAt).toLocaleString()}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Green ▲ (improved) / red ▼ (regressed) / grey • (unchanged) + the % magnitude. Nothing when no prior report. */
function DeltaIndicator({ delta }: { delta?: MetricDelta }) {
  if (!delta || !delta.hasPrev || delta.value === null) return null;
  if (delta.improved === null) {
    return <span style={{ color: '#9ca3af', fontSize: 11 }}>•</span>;
  }
  const color = delta.improved ? '#0cce6b' : '#ff4e42';
  const arrow = delta.improved ? '▲' : '▼';
  const pctText =
    delta.percent == null ? '' : ` ${Math.abs(delta.percent) < 10 ? Math.abs(delta.percent).toFixed(1) : Math.round(Math.abs(delta.percent))}%`;
  return (
    <span style={{ color, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }} aria-label={`${delta.improved ? 'improved' : 'regressed'}${pctText}`}>
      {arrow}
      {pctText}
    </span>
  );
}

function ScoreBadge({ label, score, delta }: { label: string; score: number | null; delta?: MetricDelta }) {
  return (
    <div style={{ textAlign: 'center', minWidth: 90 }}>
      <div
        style={{
          width: 56,
          height: 56,
          borderRadius: '50%',
          margin: '0 auto',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: `4px solid ${scoreColor(score)}`,
          color: scoreColor(score),
          fontWeight: 700,
        }}
      >
        {score ?? '—'}
      </div>
      <div style={{ fontSize: 12, marginTop: 4 }}>{label}</div>
      <div style={{ marginTop: 2, minHeight: 14 }}>
        <DeltaIndicator delta={delta} />
      </div>
    </div>
  );
}

const LAB_ROWS: Array<[keyof PageSpeedSummary['metrics'], string]> = [
  ['lcp', 'LCP'],
  ['fcp', 'FCP'],
  ['cls', 'CLS'],
  ['tbt', 'TBT'],
  ['speedIndex', 'Speed Index'],
  ['tti', 'TTI'],
];

function PageSpeedResult({
  summary,
  deltas,
}: {
  summary: PageSpeedSummary;
  deltas: Record<MetricKey, MetricDelta>;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <ScoreBadge label="Performance" score={summary.categories.performance} delta={deltas.performance} />
        <ScoreBadge label="Accessibility" score={summary.categories.accessibility} delta={deltas.accessibility} />
        <ScoreBadge label="Best Practices" score={summary.categories.bestPractices} delta={deltas.bestPractices} />
        <ScoreBadge label="SEO" score={summary.categories.seo} delta={deltas.seo} />
      </div>

      <div>
        <h4 style={{ margin: '0 0 8px' }}>Lab metrics</h4>
        <table style={{ borderCollapse: 'collapse', fontSize: 13 }}>
          <tbody>
            {LAB_ROWS.map(([key, label]) => (
              <tr key={key}>
                <td style={{ padding: '2px 16px 2px 0', color: '#6b7280' }}>{label}</td>
                <td style={{ padding: '2px 12px 2px 0', fontWeight: 600 }}>{summary.metrics[key].displayValue}</td>
                <td style={{ padding: '2px 0' }}>
                  <DeltaIndicator delta={deltas[key]} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {summary.fieldData && (
        <div>
          <h4 style={{ margin: '0 0 8px' }}>
            Field data (real users, CrUX) — {summary.fieldData.overallCategory ?? 'n/a'}
          </h4>
          <div style={{ fontSize: 13, color: '#6b7280' }}>
            LCP {summary.fieldData.lcp.category ?? '—'} · INP {summary.fieldData.inp.category ?? '—'} · CLS{' '}
            {summary.fieldData.cls.category ?? '—'}
          </div>
        </div>
      )}

      {summary.opportunities.length > 0 && (
        <div>
          <h4 style={{ margin: '0 0 8px' }}>Top opportunities</h4>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
            {summary.opportunities.map((o) => (
              <li key={o.id}>
                {o.title} — <strong>{o.displayValue}</strong>
              </li>
            ))}
          </ul>
        </div>
      )}

      <a href={summary.reportUrl} target="_blank" rel="noreferrer" style={{ fontSize: 13 }}>
        Open full report on PageSpeed Insights ↗
      </a>
    </div>
  );
}
