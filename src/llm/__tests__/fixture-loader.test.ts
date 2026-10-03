/**
 * Verifies the .sse-tape → TurnResult parser used by replay.
 */

import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadFixtureTelemetry, loadFixtureTranscript, loadFixtureTurn } from '../fixtures/loader';
import { evaluateAsserts } from '../asserts';
import type { RunSummary } from '../types';

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

describe('loadFixtureTelemetry', () => {
  it('round-trips exported canonical rows and restores dates for replay assertions', () => {
    const startedAt = new Date('2026-10-03T10:00:00Z');
    const tool = {
      toolName: 'harness:status', argsJson: { slug: 'test' }, resultJson: { ok: true },
      costUsd: 0.02, latencyMs: 17, metadataJson: { source: 'fixture' },
    };
    const chain = {
      chainId: 'captured-chain', turnIdx: 0, trigger: 'continue', startedAt,
      elapsedSecsInChain: 12, wasCapped: true, capReason: 'wallclock',
    };
    write('canonical.telemetry.json', JSON.stringify({
      toolInvocations: [tool], continueChainRows: [chain],
    }));
    const telemetry = loadFixtureTelemetry(join(dir, 'canonical.sse'));
    expect(telemetry).toEqual({ toolInvocations: [tool], continueChainRows: [chain] });
    expect(telemetry?.continueChainRows[0].startedAt).toBeInstanceOf(Date);

    const run: RunSummary = {
      runId: 'fixture', scenarioId: 'fixture', scenarioVersion: 1, scenarioTarget: 'operator',
      identityHash: 'fixture', sutModel: 'replay', judgeModel: 'replay', personaId: 'fixture',
      personaTraits: {
        verbosity: 'terse', politeness: 'neutral', clarification: 'never_clarifies',
        goalClarity: 'precise', interrupts: false, modality: 'text',
      },
      workspaceMode: 'isolated', transportMode: 'http-sse', turns: [],
      toolInvocations: telemetry!.toolInvocations, continueChainRows: telemetry!.continueChainRows,
      totalCostUsd: 0, startedAt, finishedAt: startedAt, finishReason: 'completed', capBreaches: [],
    };
    expect(evaluateAsserts([{ kind: 'tool_called', name: 'harness:status' }], run)).toEqual([]);
    expect(evaluateAsserts([{ kind: 'continue_chain_within_cap', maxTurns: 3, maxSecs: 10 }], run))
      .toEqual([expect.objectContaining({ severity: 'error', claim: expect.stringContaining('12.0s') })]);
  });

  it('normalizes legacy tool names and metadata without losing evidence', () => {
    write('legacy.telemetry.json', JSON.stringify({
      toolInvocations: [{ name: 'coord:send', metadata_json: { uiClientId: 'fixture' } }],
      continueChainRows: [],
    }));
    expect(loadFixtureTelemetry(join(dir, 'legacy.sse'))).toEqual({
      toolInvocations: [{
        toolName: 'coord:send', argsJson: null, resultJson: null, costUsd: 0, latencyMs: 0,
        metadataJson: { uiClientId: 'fixture' },
      }],
      continueChainRows: [],
    });
  });

  it('keeps missing sidecars and telemetry-free fixtures usable', () => {
    expect(loadFixtureTelemetry(join(dir, 'missing.sse'))).toBeNull();
    write('empty.telemetry.json', '{}');
    expect(loadFixtureTelemetry(join(dir, 'empty.sse'))).toEqual({ toolInvocations: [], continueChainRows: [] });
  });

  it.each([
    ['invalid date', { chainId: 'a', turnIdx: 0, trigger: 'continue', startedAt: 'invalid', elapsedSecsInChain: 1, wasCapped: false, capReason: null }],
    ['missing chain identity', { ts: '2026-10-03T10:00:00Z', trigger: 'continue', secondsSinceChainStart: 1, chainTurnCount: 2 }],
    ['invalid trigger', { chainId: 'a', turnIdx: 0, trigger: 'invented', startedAt: '2026-10-03T10:00:00Z', elapsedSecsInChain: 1, wasCapped: false, capReason: null }],
  ])('rejects %s rather than turning invalid chain evidence into a passing replay', (_name, row) => {
    write('invalid.telemetry.json', JSON.stringify({ toolInvocations: [], continueChainRows: [row] }));
    expect(() => loadFixtureTelemetry(join(dir, 'invalid.sse'))).toThrow(/telemetry/i);
  });

  it.each(['null', '{', '{"toolInvocations":false}', '{"toolInvocations":[{}]}'])
    ('rejects malformed present telemetry: %s', (body) => {
      write('malformed.telemetry.json', body);
      expect(() => loadFixtureTelemetry(join(dir, 'malformed.sse'))).toThrow();
    });
});

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

  it('loads sim-user evidence from an exported normalized transcript sidecar', () => {
    const p = write('with-context.sse', [
      'event: delta',
      'data: {"text":"Approved."}',
      '',
      'event: done',
      'data: {}',
      '',
    ].join('\n'));
    write('with-context.transcript.json', JSON.stringify({
      schemaVersion: 1,
      turns: [{
        idx: 0,
        assistantText: 'Approved.',
        toolCalls: [],
        toolResults: [{
          name: 'work_items:get',
          output: '{"ok":true,"id":"WI-200"}',
          isError: false,
          truncated: false,
          sourceChars: 25,
        }],
        cards: [],
        controlTags: [],
        finishReason: 'done',
        costUsd: 0,
        latencyMs: 1,
        error: null,
        userText: 'Please approve this write.',
        simThought: 'approval needed',
        simKind: 'text',
      }],
    }));

    const turns = loadFixtureTranscript(p);
    expect(turns).toHaveLength(1);
    expect(turns?.[0]).toMatchObject({
      assistantText: 'Approved.',
      toolResults: [expect.objectContaining({
        name: 'work_items:get',
        output: expect.stringContaining('WI-200'),
      })],
      userText: 'Please approve this write.',
      simThought: 'approval needed',
      simKind: 'text',
    });
    // The one-turn convenience loader also merges the sidecar while
    // preserving the raw SSE tape for callers that need it.
    expect(loadFixtureTurn(p).rawSseTape).toHaveLength(2);
  });
});
