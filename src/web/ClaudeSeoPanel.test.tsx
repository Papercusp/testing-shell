// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import ClaudeSeoPanel from './ClaudeSeoPanel';
import type { SeoReport } from '../seo';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function rec(id: string, score: number, createdAt: string): SeoReport {
  return { id, project: 'restart', url: 'https://shop.buyrestart.com/', command: 'page', score, report: `# Report ${id}\nOverall Score: ${score}/100\nfindings…`, createdAt };
}
const NEW = rec('r2', 80, '2026-06-04T02:00:00Z');
const OLD = rec('r1', 72, '2026-06-04T01:00:00Z');

const enc = new TextEncoder();
function sseResponse(frames: string): Response {
  const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode(frames)); c.close(); } });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function stubFetch(history: SeoReport[], postFrames?: string, postOk = true) {
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      if (!postOk) return { ok: false, status: 400, json: async () => ({ error: 'bad command' }) } as Response;
      return sseResponse(postFrames ?? 'event: report\ndata: {"report":"# Fresh\\nOverall Score: 84/100"}\n\nevent: done\ndata: {"score":84}\n\nevent: saved\ndata: {"id":"new1"}\n\n');
    }
    const u = String(input);
    if (u.includes('/urls')) return { ok: true, json: async () => ({ urls: [{ url: 'https://shop.buyrestart.com/', count: history.length, lastRunAt: '2026-06-04T02:00:00Z' }] }) } as Response;
    if (u.includes('/results')) return { ok: true, json: async () => ({ results: history }) } as Response;
    return { ok: true, json: async () => ({}) } as Response;
  }));
}

const props = {
  runEndpoint: '/api/claude-seo/run',
  resultsEndpoint: '/api/claude-seo/results',
  urlsEndpoint: '/api/claude-seo/urls',
  defaultUrl: 'https://shop.buyrestart.com',
};

describe('ClaudeSeoPanel', () => {
  it('renders the newest history report with a score delta vs the previous run', async () => {
    stubFetch([NEW, OLD]);
    render(<ClaudeSeoPanel {...props} />);
    expect((screen.getByLabelText('SEO command') as HTMLSelectElement).value).toBe('page');
    await waitFor(() => expect(screen.getByText(/▲ 8 vs previous/)).toBeTruthy()); // 80 vs 72
    expect(document.body.textContent).toContain('Overall Score: 80/100');
  });

  it('runs a command: streams + shows the fresh report', async () => {
    stubFetch([NEW, OLD]);
    render(<ClaudeSeoPanel {...props} />);
    await waitFor(() => expect(screen.getByText(/vs previous/)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /^run$/i }));
    await waitFor(() => expect(document.body.textContent).toContain('Overall Score: 84/100'));
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.some((c) => (c[1] as RequestInit)?.method === 'POST')).toBe(true);
  });

  it('shows the server error on a bad request', async () => {
    stubFetch([], undefined, false);
    render(<ClaudeSeoPanel {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /^run$/i }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/bad command/));
  });

  it('warns when a heavy command (audit) is selected', async () => {
    stubFetch([]);
    render(<ClaudeSeoPanel {...props} />);
    fireEvent.change(screen.getByLabelText('SEO command'), { target: { value: 'audit' } });
    expect(document.body.textContent).toMatch(/fans out many subagents/i);
  });
});
