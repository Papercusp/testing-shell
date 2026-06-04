import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SEO_COMMANDS, SEO_COMMAND_META, type SeoCommand, type SeoReport } from '../seo';

export interface ClaudeSeoPanelProps {
  /** POST { command, url } → SSE (log/report/done/saved/error). */
  runEndpoint: string;
  /** GET → { results: SeoReport[] } (filterable by ?url=&command=). Omit → no history. */
  resultsEndpoint?: string;
  /** GET → { urls: {url,count,lastRunAt}[] }. Omit → no URL selector. */
  urlsEndpoint?: string;
  defaultUrl: string;
  defaultCommand?: SeoCommand;
}

type RunState = 'idle' | 'running' | 'error';

function scoreColor(s: number | null): string {
  if (s == null) return '#9ca3af';
  if (s >= 90) return '#0cce6b';
  if (s >= 50) return '#ffa400';
  return '#ff4e42';
}

function normalizeUrl(u: string): string {
  try {
    return new URL(u).toString();
  } catch {
    return u;
  }
}

function join(base: string, params: Record<string, string | undefined>): string {
  const qs = Object.entries(params)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`)
    .join('&');
  if (!qs) return base;
  return `${base}${base.includes('?') ? '&' : '?'}${qs}`;
}

/** Parse the `event: <type>\ndata: <json>\n\n` SSE stream (claude-seo / ai-explore format). */
async function readEventStream(res: Response, onEvent: (type: string, data: Record<string, unknown>) => void, signal: AbortSignal): Promise<void> {
  const reader = res.body?.pipeThrough(new TextDecoderStream()).getReader();
  if (!reader) return;
  let buf = '';
  let currentEvent: string | null = null;
  for (;;) {
    if (signal.aborted) {
      await reader.cancel().catch(() => {});
      return;
    }
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (line === '') {
        currentEvent = null;
        continue;
      }
      if (line.startsWith('event: ')) {
        currentEvent = line.slice(7).trim();
      } else if (line.startsWith('data: ') && currentEvent) {
        try {
          onEvent(currentEvent, JSON.parse(line.slice(6)));
        } catch {
          /* partial */
        }
      }
    }
  }
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard unavailable */
        }
      }}
    >
      {done ? 'Copied ✓' : label}
    </button>
  );
}

export default function ClaudeSeoPanel({ runEndpoint, resultsEndpoint, urlsEndpoint, defaultUrl, defaultCommand = 'page' }: ClaudeSeoPanelProps) {
  const [url, setUrl] = useState(defaultUrl);
  const [command, setCommand] = useState<SeoCommand>(defaultCommand);
  const [runState, setRunState] = useState<RunState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [ranReport, setRanReport] = useState<{ report: string; score: number | null } | null>(null);
  const [history, setHistory] = useState<SeoReport[]>([]);
  const [urls, setUrls] = useState<{ url: string; count: number; lastRunAt: string }[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const loadUrls = useCallback(async () => {
    if (!urlsEndpoint) return;
    try {
      const r = await fetch(urlsEndpoint);
      if (r.ok) setUrls(((await r.json()) as { urls: typeof urls }).urls ?? []);
    } catch {
      /* ignore */
    }
  }, [urlsEndpoint]);

  const loadHistory = useCallback(async () => {
    if (!resultsEndpoint) return;
    try {
      const r = await fetch(join(resultsEndpoint, { url: normalizeUrl(url), command, limit: '15' }));
      if (r.ok) setHistory(((await r.json()) as { results: SeoReport[] }).results ?? []);
    } catch {
      /* ignore */
    }
  }, [resultsEndpoint, url, command]);

  useEffect(() => {
    void loadUrls();
  }, [loadUrls]);
  useEffect(() => {
    setSelectedId(null);
    setRanReport(null);
    void loadHistory();
  }, [loadHistory]);

  const run = useCallback(async () => {
    setRunState('running');
    setError(null);
    setLogs([]);
    setRanReport(null);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const res = await fetch(runEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command, url }),
        signal: ac.signal,
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error((d as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      let report = '';
      let score: number | null = null;
      await readEventStream(
        res,
        (type, data) => {
          if (type === 'log') setLogs((p) => [...p.slice(-400), String(data.line ?? '')]);
          else if (type === 'report') report = String(data.report ?? '');
          else if (type === 'done') score = typeof data.score === 'number' ? data.score : null;
          else if (type === 'error') setError(String(data.message ?? 'error'));
          else if (type === 'saved') setSelectedId(String(data.id ?? '') || null);
        },
        ac.signal,
      );
      if (report) setRanReport({ report, score });
      setRunState('idle');
      void loadHistory();
      void loadUrls();
    } catch (e) {
      if (!ac.signal.aborted) {
        setError(e instanceof Error ? e.message : String(e));
        setRunState('error');
      }
    }
  }, [runEndpoint, command, url, loadHistory, loadUrls]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setRunState('idle');
  }, []);

  // Report shown + previous (same url+command) for the score delta.
  const { shown, prevScore } = useMemo(() => {
    const fromHistory = selectedId ? history.find((r) => r.id === selectedId) : history[0];
    if (fromHistory) {
      const idx = history.findIndex((r) => r.id === fromHistory.id);
      return { shown: { report: fromHistory.report, score: fromHistory.score }, prevScore: history[idx + 1]?.score ?? null };
    }
    return { shown: ranReport, prevScore: history[0]?.score ?? null };
  }, [history, selectedId, ranReport]);

  const delta = shown?.score != null && prevScore != null ? shown.score - prevScore : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <select aria-label="SEO command" value={command} onChange={(e) => setCommand(e.target.value as SeoCommand)}>
          {SEO_COMMANDS.map((c) => (
            <option key={c} value={c}>{SEO_COMMAND_META[c].label}</option>
          ))}
        </select>
        <input aria-label="URL to audit" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://shop.buyrestart.com" style={{ flex: '1 1 300px', padding: '6px 8px' }} />
        {urls.length > 0 && (
          <select aria-label="Known URLs" value={urls.some((u) => u.url === url) ? url : ''} onChange={(e) => e.target.value && setUrl(e.target.value)}>
            <option value="">— past URLs —</option>
            {urls.map((u) => (<option key={u.url} value={u.url}>{u.url} ({u.count})</option>))}
          </select>
        )}
        {runState === 'running' ? (
          <button type="button" onClick={stop}>Stop</button>
        ) : (
          <button type="button" onClick={() => void run()}>Run</button>
        )}
      </div>

      <p style={{ fontSize: 12, color: '#6b7280', margin: 0 }}>
        Runs the claude-seo skill via headless Claude Code — agentic, takes minutes, costs tokens.
        {SEO_COMMAND_META[command].heavy ? ' ⚠️ This command fans out many subagents (heaviest).' : ''} Public URL only.
      </p>

      {error && <div role="alert" style={{ color: '#ff4e42' }}>Error: {error}</div>}

      {runState === 'running' && (
        <div>
          <div style={{ marginBottom: 4 }}>Running <code>/seo {command} {url}</code>…</div>
          <pre style={{ maxHeight: 220, overflow: 'auto', background: '#0b0b0b', color: '#cbd5e1', padding: 8, fontSize: 12, borderRadius: 4 }}>
            {logs.join('\n') || '…'}
          </pre>
        </div>
      )}

      {shown && runState !== 'running' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <div style={{ width: 64, height: 64, borderRadius: '50%', border: `5px solid ${scoreColor(shown.score)}`, color: scoreColor(shown.score), display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 18 }}>
              {shown.score ?? '—'}
            </div>
            <div>
              <div style={{ fontSize: 12, color: '#6b7280' }}>SEO score (/100)</div>
              {delta != null && delta !== 0 && (
                <div style={{ color: delta > 0 ? '#0cce6b' : '#ff4e42', fontWeight: 700, fontSize: 13 }}>
                  {delta > 0 ? '▲' : '▼'} {Math.abs(delta)} vs previous
                </div>
              )}
            </div>
            <div style={{ marginLeft: 'auto' }}>
              <CopyButton text={shown.report} label="Copy report (for an agent)" />
            </div>
          </div>
          <pre style={{ maxHeight: 460, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: '#fafafa', border: '1px solid #e5e7eb', padding: 12, fontSize: 12, borderRadius: 6, lineHeight: 1.5 }}>
            {shown.report}
          </pre>
        </div>
      )}

      {resultsEndpoint && history.length > 0 && (
        <div>
          <h4 style={{ margin: '6px 0' }}>Past reports — {command} · {url}</h4>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
            {history.map((h) => {
              const active = h.id === (selectedId ?? history[0]?.id);
              return (
                <li key={h.id}>
                  <button type="button" onClick={() => setSelectedId(h.id)} style={{ display: 'flex', gap: 12, alignItems: 'center', width: '100%', textAlign: 'left', padding: '4px 8px', border: 'none', borderLeft: `3px solid ${active ? '#3b82f6' : 'transparent'}`, background: active ? 'rgba(59,130,246,0.08)' : 'transparent', cursor: 'pointer', fontSize: 13 }}>
                    <span style={{ color: scoreColor(h.score), fontWeight: 700, width: 28 }}>{h.score ?? '—'}</span>
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
