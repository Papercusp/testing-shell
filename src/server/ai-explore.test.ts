import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('node:fs', () => ({ existsSync: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import {
  DEFAULT_MODELS,
  parseAiExploreConfig,
  resolveStagehandRunner,
  parseAiExploreLine,
  spawnAiExplore,
  spawnAiExploreSSE,
} from './ai-explore';

beforeEach(() => vi.clearAllMocks());

describe('DEFAULT_MODELS', () => {
  it('has the three claude models', () => {
    expect(DEFAULT_MODELS.map((m) => m.value)).toEqual([
      'anthropic/claude-sonnet-4-6',
      'anthropic/claude-haiku-4-5',
      'anthropic/claude-opus-4-7',
    ]);
  });
});

describe('parseAiExploreConfig', () => {
  it('requires a goal', () => {
    expect(parseAiExploreConfig({})).toEqual({ ok: false, msg: 'goal is required' });
    expect(parseAiExploreConfig({ goal: '  ' })).toEqual({ ok: false, msg: 'goal is required' });
  });

  it('requires a startUrl when no default is supplied', () => {
    expect(parseAiExploreConfig({ goal: 'do a thing' })).toEqual({ ok: false, msg: 'startUrl is required' });
  });

  it('falls back to opts.defaultStartUrl + clamps maxSteps/maxCostUsd', () => {
    const r = parseAiExploreConfig({ goal: 'walk', maxSteps: 999, maxCostUsd: 0.001 }, { defaultStartUrl: 'http://localhost:3001/' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.cfg.startUrl).toBe('http://localhost:3001/');
      expect(r.cfg.maxSteps).toBe(50);
      expect(r.cfg.maxCostUsd).toBe(0.05);
      expect(r.cfg.model).toBe('anthropic/claude-sonnet-4-6');
      expect(r.cfg.headless).toBe(true);
    }
  });

  it('honors an explicit startUrl + headless:false', () => {
    const r = parseAiExploreConfig({ goal: 'g', startUrl: 'http://x/', headless: false }, { defaultStartUrl: 'http://default/' });
    expect(r.ok && r.cfg.startUrl).toBe('http://x/');
    expect(r.ok && r.cfg.headless).toBe(false);
  });
});

describe('parseAiExploreLine', () => {
  it('parses NDJSON and falls back to a log event', () => {
    expect(parseAiExploreLine('{"type":"step","n":1}')).toEqual({ type: 'step', n: 1 });
    expect(parseAiExploreLine('not json')).toEqual({ type: 'log', level: 'info', line: 'not json' });
    expect(parseAiExploreLine('   ')).toBeNull();
    expect(parseAiExploreLine('{"no":"type"}')).toBeNull();
  });
});

describe('resolveStagehandRunner', () => {
  it('returns the path or null', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    expect(resolveStagehandRunner('/repo')).toContain('libs/testing-shell/src/server/stagehand-runner.mjs');
    vi.mocked(existsSync).mockReturnValue(false);
    expect(resolveStagehandRunner('/repo')).toBeNull();
  });
});

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter; stderr: EventEmitter;
    stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: vi.fn(), end: vi.fn() };
  return child;
}
async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let out = '';
  for (;;) { const { value, done } = await reader.read(); if (done) break; out += dec.decode(value); }
  return out;
}

describe('spawnAiExplore', () => {
  it('writes cfg+apiKey to stdin and returns the child', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    const child = fakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const cfg = { goal: 'g', startUrl: 'http://x/', model: 'm', maxSteps: 5, maxCostUsd: 1, headless: true };
    const out = spawnAiExplore(cfg, { repoRoot: '/repo', apiKey: 'sk-123' });
    expect(out).toBe(child);
    const written = child.stdin.write.mock.calls[0][0] as string;
    expect(JSON.parse(written)).toMatchObject({ goal: 'g', apiKey: 'sk-123', startUrl: 'http://x/' });
    expect(child.stdin.end).toHaveBeenCalled();
  });

  it('returns null when the runner is missing', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(spawnAiExplore({ goal: 'g', startUrl: 'u', model: 'm', maxSteps: 1, maxCostUsd: 1, headless: true }, { repoRoot: '/repo', apiKey: 'k' })).toBeNull();
  });

  // WI-37573: the gateway seam. The runner points Stagehand's model client at `baseUrl`, which
  // is what lets this route use the default account instead of a raw Anthropic key.
  it('threads baseUrl to the runner when one is supplied', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    const child = fakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const cfg = { goal: 'g', startUrl: 'http://x/', model: 'm', maxSteps: 5, maxCostUsd: 1, headless: true };
    spawnAiExplore(cfg, { repoRoot: '/repo', apiKey: 'placeholder', baseUrl: 'http://127.0.0.1:8788' });
    const written = child.stdin.write.mock.calls[0][0] as string;
    expect(JSON.parse(written)).toMatchObject({ apiKey: 'placeholder', baseUrl: 'http://127.0.0.1:8788' });
  });

  // The claim the production comment makes: omitting baseUrl leaves the direct-to-Anthropic
  // payload byte-identical, so this seam cannot perturb the pre-existing path. `toMatchObject`
  // would pass on a stray `baseUrl: undefined`, so assert on the KEY's absence.
  it('omits baseUrl entirely when none is supplied', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    const child = fakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const cfg = { goal: 'g', startUrl: 'http://x/', model: 'm', maxSteps: 5, maxCostUsd: 1, headless: true };
    spawnAiExplore(cfg, { repoRoot: '/repo', apiKey: 'sk-123' });
    const written = child.stdin.write.mock.calls[0][0] as string;
    expect(Object.keys(JSON.parse(written))).not.toContain('baseUrl');
    expect(written).toBe(JSON.stringify({ ...cfg, apiKey: 'sk-123' }));
  });
});

describe('spawnAiExploreSSE', () => {
  it('relays runner NDJSON as SSE event frames + a done frame on exit', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    const child = fakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const stream = spawnAiExploreSSE({ goal: 'g', startUrl: 'http://x/', model: 'm', maxSteps: 1, maxCostUsd: 1, headless: true }, { repoRoot: '/repo', apiKey: 'k' });
    child.stdout.emit('data', Buffer.from('{"type":"start","goal":"g"}\n{"type":"step","n":1,"ok":true}\n'));
    child.stderr.emit('data', Buffer.from('some stderr noise\n'));
    child.emit('exit', 0);
    const out = await drain(stream);
    expect(out).toContain('event: start\ndata: {"goal":"g"}');
    expect(out).toContain('event: step\ndata: {"n":1,"ok":true}');
    expect(out).toContain('event: log\ndata: {"level":"error","line":"some stderr noise"}');
    expect(out).toContain('event: done\ndata: {"totalMs":0,"steps":0,"costUsd":0,"exitCode":0}');
  });

  it('emits an error frame when the runner is missing', async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const stream = spawnAiExploreSSE({ goal: 'g', startUrl: 'u', model: 'm', maxSteps: 1, maxCostUsd: 1, headless: true }, { repoRoot: '/repo', apiKey: 'k' });
    expect(await drain(stream)).toContain('event: error');
  });
});
