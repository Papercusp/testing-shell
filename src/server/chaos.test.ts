import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('node:fs', () => ({ existsSync: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { ALLOWED_BASE, clampMaxSteps, resolveChaosRunner, spawnChaosWebStream } from './chaos';

beforeEach(() => vi.clearAllMocks());

describe('clampMaxSteps', () => {
  it('clamps + defaults', () => {
    expect(clampMaxSteps(undefined)).toBe(25);
    expect(clampMaxSteps(NaN)).toBe(25);
    expect(clampMaxSteps(0)).toBe(25); // 0 || 25 → 25
    expect(clampMaxSteps(-3)).toBe(1);
    expect(clampMaxSteps(999)).toBe(200);
    expect(clampMaxSteps('50')).toBe(50);
  });
});

describe('ALLOWED_BASE', () => {
  it('allows localhost/127.0.0.1 only', () => {
    expect(ALLOWED_BASE.test('http://localhost:4321/')).toBe(true);
    expect(ALLOWED_BASE.test('http://127.0.0.1:3070')).toBe(true);
    expect(ALLOWED_BASE.test('https://evil.com/')).toBe(false);
    expect(ALLOWED_BASE.test('http://example.localhost.evil.com')).toBe(false);
  });
});

describe('resolveChaosRunner', () => {
  it('returns the path when present, null otherwise', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    expect(resolveChaosRunner('/repo')).toContain('libs/testing-shell/src/web/chaos-runner.mjs');
    vi.mocked(existsSync).mockReturnValue(false);
    expect(resolveChaosRunner('/repo')).toBeNull();
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
  for (;;) { const { value, done } = await reader.read(); if (done) break; out += dec.decode(value); }
  return out;
}

describe('spawnChaosWebStream', () => {
  it('forwards runner NDJSON verbatim and wraps stderr as an error event', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    const child = fakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);

    const stream = spawnChaosWebStream({ baseUrl: 'http://localhost:3001/', maxSteps: 10, repoRoot: '/repo' });
    child.stdout.emit('data', Buffer.from('{"type":"step","n":1,"ok":true}\n'));
    child.stderr.emit('data', Buffer.from('chromium launch failed'));
    child.emit('close', 0);

    const out = await drain(stream);
    expect(out).toContain('{"type":"step","n":1,"ok":true}');
    expect(out).toContain('{"type":"error","message":"chromium launch failed"}');
    // runner spawned with baseUrl + steps
    const [bin, args] = vi.mocked(spawn).mock.calls[0];
    expect(String(bin)).toBeTruthy();
    expect(args as string[]).toContain('http://localhost:3001/');
    expect(args as string[]).toContain('10');
  });

  it('emits a clean error when the runner is missing', async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const stream = spawnChaosWebStream({ baseUrl: 'http://localhost:3001/', maxSteps: 10, repoRoot: '/repo' });
    const out = await drain(stream);
    expect(out).toContain('chaos-runner not found');
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
  });
});
