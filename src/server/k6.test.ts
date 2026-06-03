import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { parseScriptMeta, listK6Scripts, listK6Results, getK6Result, runK6Stream } from './k6';

const SAMPLE = `/**
 * @id smoke
 * @name Smoke Test
 * @description Quick sanity check across all services
 * @category smoke
 * @estimatedDuration 30s
 * @defaultVUs 2
 */
import http from 'k6/http';
`;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('parseScriptMeta', () => {
  it('extracts the doc-comment tags', () => {
    const m = parseScriptMeta(SAMPLE, 'smoke.js');
    expect(m).toEqual({
      id: 'smoke',
      name: 'Smoke Test',
      description: 'Quick sanity check across all services',
      category: 'smoke',
      estimatedDuration: '30s',
      defaultVUs: 2,
    });
  });

  it('defaults id from filename and category/VUs when tags absent', () => {
    const m = parseScriptMeta('// no tags here', 'web-stress.js');
    expect(m.id).toBe('web-stress');
    expect(m.name).toBe('web-stress');
    expect(m.category).toBe('load');
    expect(m.defaultVUs).toBe(10);
  });
});

describe('listK6Scripts', () => {
  it('returns [] when the dir is missing', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(listK6Scripts('/nope')).toEqual([]);
  });

  it('parses every *.js script in the dir', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue(['smoke.js', 'README.md', 'stress.js'] as never);
    vi.mocked(readFileSync).mockReturnValue(SAMPLE as never);
    const scripts = listK6Scripts('/scripts');
    expect(scripts.map((s) => s.id)).toEqual(['smoke', 'stress']);
  });
});

describe('listK6Results / getK6Result', () => {
  it('returns results newest-first and reads one by id', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue(['a.meta.json', 'b.meta.json'] as never);
    vi.mocked(readFileSync).mockImplementation(((p: string) => {
      if (String(p).includes('a.meta.json')) return JSON.stringify({ id: 'a', scriptId: 's', scriptName: 'S', startedAt: '2026-06-01T00:00:00Z', exitCode: 0, log: [] });
      return JSON.stringify({ id: 'b', scriptId: 's', scriptName: 'S', startedAt: '2026-06-02T00:00:00Z', exitCode: 0, log: [] });
    }) as never);
    const results = listK6Results('/results');
    expect(results.map((r) => r.id)).toEqual(['b', 'a']); // newest first
    const one = getK6Result('/results', 'a');
    expect(one?.id).toBe('a');
  });

  it('rejects a traversal id', () => {
    expect(getK6Result('/results', '../etc/passwd')).toBeNull();
  });
});

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let out = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out += dec.decode(value);
  }
  return out;
}

describe('runK6Stream', () => {
  it('streams log frames then a done frame, and writes a meta sidecar', async () => {
    const child = fakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    vi.mocked(readFileSync).mockReturnValue(SAMPLE as never);

    const stream = runK6Stream({
      k6Bin: '/bin/k6', scriptId: 'smoke', scriptsDir: '/s', resultsDir: '/r', repoRoot: '/repo',
      vus: 5, now: () => 1700000000000,
    });

    // emit two stdout lines + close(0) before draining
    child.stdout.emit('data', Buffer.from('checks.....: 100%\n'));
    child.stdout.emit('data', Buffer.from('data_received\n'));
    child.emit('close', 0);

    const out = await drain(stream);
    expect(out).toContain('data: {"type":"log","message":"checks.....: 100%"}');
    expect(out).toContain('"type":"done"');
    expect(out).toContain('"code":0');

    // spawn invoked with the resolved script path + vus
    const args = vi.mocked(spawn).mock.calls[0];
    expect(args[0]).toBe('/bin/k6');
    expect(args[1]).toContain('--vus');
    expect((args[1] as string[]).some((a) => a.endsWith('smoke.js'))).toBe(true);

    // sidecar written with the collected log
    const writes = vi.mocked(writeFileSync).mock.calls;
    const meta = writes.find((c) => String(c[0]).endsWith('.meta.json'));
    expect(meta).toBeTruthy();
    expect(String(meta![1])).toContain('checks.....: 100%');
    expect(String(meta![1])).toContain('"scriptName":"Smoke Test"');
  });

  it('emits an error frame on spawn error', async () => {
    const child = fakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    vi.mocked(readFileSync).mockReturnValue('' as never);
    const stream = runK6Stream({ k6Bin: '/bin/k6', scriptId: 'x', scriptsDir: '/s', resultsDir: '/r', repoRoot: '/repo', now: () => 1 });
    child.emit('error', new Error('k6 not found'));
    const out = await drain(stream);
    expect(out).toContain('"type":"error"');
    expect(out).toContain('k6 not found');
  });
});
