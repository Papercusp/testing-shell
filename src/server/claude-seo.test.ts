import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { parseClaudeSeoConfig, parseSeoScore, spawnClaudeSeoStream } from './claude-seo';

describe('parseClaudeSeoConfig', () => {
  it('defaults command to page + uses defaultUrl', () => {
    const r = parseClaudeSeoConfig({}, { defaultUrl: 'https://shop.buyrestart.com' });
    expect(r).toEqual({ ok: true, cfg: { command: 'page', url: 'https://shop.buyrestart.com/' } });
  });
  it('accepts a valid command', () => {
    const r = parseClaudeSeoConfig({ command: 'audit', url: 'https://x.com' });
    expect(r.ok && r.cfg.command).toBe('audit');
  });
  it('rejects an unknown command', () => {
    expect(parseClaudeSeoConfig({ command: 'nope', url: 'https://x.com' }).ok).toBe(false);
  });
  it('rejects localhost + missing url', () => {
    expect(parseClaudeSeoConfig({ url: 'http://localhost:3000' }).ok).toBe(false);
    expect(parseClaudeSeoConfig({}).ok).toBe(false);
  });
});

describe('parseSeoScore', () => {
  it('reads "Overall Score: NN/100"', () => expect(parseSeoScore('blah\nOverall Score: 73/100\n')).toBe(73));
  it('reads "SEO Score: NN / 100"', () => expect(parseSeoScore('SEO Score: 88 / 100')).toBe(88));
  it('falls back to the first NN/100', () => expect(parseSeoScore('On-Page: 42/100')).toBe(42));
  it('returns null when absent', () => expect(parseSeoScore('no score here')).toBeNull());
});

// ─── streaming runner (injected fake spawn) ──────────────────────────────────

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  return child;
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Array<{ type: string; data: Record<string, unknown> }>> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value);
  }
  const frames: Array<{ type: string; data: Record<string, unknown> }> = [];
  for (const f of buf.split('\n\n')) {
    if (!f.trim()) continue;
    const ev = f.split('\n').find((l) => l.startsWith('event: '));
    const dt = f.split('\n').find((l) => l.startsWith('data: '));
    if (ev && dt) frames.push({ type: ev.slice(7), data: JSON.parse(dt.slice(6)) });
  }
  return frames;
}

describe('spawnClaudeSeoStream', () => {
  it('relays assistant text/tools as log frames + emits report + scored done', async () => {
    let child!: ReturnType<typeof fakeChild>;
    const spawnImpl = ((..._a: unknown[]) => {
      child = fakeChild();
      return child as never;
    }) as never;
    const stream = spawnClaudeSeoStream({ command: 'page', url: 'https://shop.buyrestart.com/' }, { homeDir: '/iso', spawnImpl });
    // start() ran synchronously → listeners attached; now feed stream-json.
    child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Analyzing the page…' }] } }) + '\n'));
    child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'WebFetch' }] } }) + '\n'));
    child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', is_error: false, total_cost_usd: 0.12, result: '# SEO\nOverall Score: 73/100\nfix things' }) + '\n'));
    const frames = await drain(stream);
    const logs = frames.filter((f) => f.type === 'log').map((f) => f.data.line);
    expect(logs).toContain('Analyzing the page…');
    expect(logs).toContain('→ WebFetch');
    const report = frames.find((f) => f.type === 'report');
    expect(report?.data.report).toContain('Overall Score: 73/100');
    const done = frames.find((f) => f.type === 'done');
    expect(done?.data.score).toBe(73);
    expect(done?.data.isError).toBe(false);
    expect(done?.data.costUsd).toBe(0.12);
  });

  it('falls back to accumulated text as the report when no result event (process exit)', async () => {
    let child!: ReturnType<typeof fakeChild>;
    const spawnImpl = ((..._a: unknown[]) => {
      child = fakeChild();
      return child as never;
    }) as never;
    const stream = spawnClaudeSeoStream({ command: 'page', url: 'https://shop.buyrestart.com/' }, { homeDir: '/iso', spawnImpl });
    child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'partial Score 55/100' }] } }) + '\n'));
    child.emit('exit', 0);
    const frames = await drain(stream);
    expect(frames.find((f) => f.type === 'report')?.data.report).toContain('55/100');
    expect(frames.find((f) => f.type === 'done')).toBeTruthy();
  });
});
