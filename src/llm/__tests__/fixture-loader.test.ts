/**
 * Verifies the .sse-tape → TurnResult parser used by replay.
 */

import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadFixtureTurn } from '../fixtures/loader';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fixture-loader-test-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, body, 'utf8');
  return p;
}

describe('loadFixtureTurn', () => {
  it('assembles delta events into assistantText', () => {
    const p = write('a.sse', [
      'event: delta',
      'data: {"text":"Hello, "}',
      '',
      'event: delta',
      'data: {"text":"world."}',
      '',
      'event: done',
      'data: {"costUsd":0.01}',
      '',
    ].join('\n'));
    const turn = loadFixtureTurn(p);
    expect(turn.assistantText).toBe('Hello, world.');
    expect(turn.costUsd).toBe(0.01);
    expect(turn.finishReason).toBe('done');
  });

  it('captures tool_call events', () => {
    const p = write('b.sse', [
      'event: tool_call',
      'data: {"name":"harness:status","input":{"slug":"sheets"}}',
      '',
      'event: done',
      'data: {}',
      '',
    ].join('\n'));
    const turn = loadFixtureTurn(p);
    expect(turn.toolCalls).toHaveLength(1);
    expect(turn.toolCalls[0]).toEqual({ name: 'harness:status', input: { slug: 'sheets' } });
  });

  it('skips heartbeat + id: lines', () => {
    const p = write('c.sse', [
      'event: heartbeat',
      'data: {"tsMs":1}',
      '',
      'id: 1',
      'event: delta',
      'data: {"text":"OK"}',
      '',
    ].join('\n'));
    const turn = loadFixtureTurn(p);
    expect(turn.assistantText).toBe('OK');
  });

  it('extracts <continue/> and <sleep/> control tags', () => {
    const p = write('d.sse', [
      'event: delta',
      'data: {"text":"<say>Checking...</say><continue/><sleep minutes=\\"5\\"/>"}',
      '',
      'event: done',
      'data: {}',
      '',
    ].join('\n'));
    const turn = loadFixtureTurn(p);
    const tags = turn.controlTags.map((c) => c.tag).sort();
    expect(tags).toEqual(['continue', 'sleep']);
  });

  it('error events set finishReason and error', () => {
    const p = write('e.sse', [
      'event: error',
      'data: {"message":"PG unavailable"}',
      '',
    ].join('\n'));
    const turn = loadFixtureTurn(p);
    expect(turn.finishReason).toBe('error');
    expect(turn.error).toBe('PG unavailable');
  });

  it('reads the actual v8-baseline scenario-01 fixture', () => {
    // Sanity check on a real fixture file shipped with the repo. The
    // fixture is committed; this test guards against accidental
    // breakage if someone reformats them.
    const fixturesDir = join(__dirname, '..', 'fixtures', 'operator', 'v8-baseline');
    const turn = loadFixtureTurn(join(fixturesDir, '01-terminal-status-question.sse'));
    expect(turn.assistantText.length).toBeGreaterThan(0);
    expect(turn.finishReason).toBe('done');
  });
});
