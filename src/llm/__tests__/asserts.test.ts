/**
 * Unit tests for the deterministic-assert evaluators.
 *
 * Builds synthetic RunSummary objects and verifies each evaluator
 * fires (or doesn't) appropriately. Covers the cross-source counting
 * (SSE tape + PG tool_invocations) that the tool.ts assert layers on.
 */

import { describe, expect, it } from 'vitest';

import { evaluateAsserts } from '../asserts/index';
import type {
  ContinueChainRow,
  PersonaTraits,
  RunSummary,
  ToolInvocationRow,
  TurnResult,
} from '../types';

const TRAITS: PersonaTraits = {
  verbosity: 'terse',
  politeness: 'neutral',
  clarification: 'never_clarifies',
  goalClarity: 'precise',
  interrupts: false,
  modality: 'text',
};

function makeRun(over: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: 'r1',
    scenarioId: 'op-test',
    scenarioVersion: 1,
    identityHash: 'h',
    sutModel: 'claude-sonnet-4-6',
    judgeModel: 'claude-sonnet-4-6',
    personaId: 'brief-admin',
    personaTraits: TRAITS,
    workspaceMode: 'isolated',
    transportMode: 'http-sse',
    turns: [],
    toolInvocations: [],
    continueChainRows: [],
    totalCostUsd: 0,
    startedAt: new Date(),
    finishedAt: new Date(),
    finishReason: 'completed',
    capBreaches: [],
    ...over,
  };
}

function makeTurn(over: Partial<TurnResult> = {}): TurnResult {
  return {
    assistantText: '',
    toolCalls: [],
    cards: [],
    controlTags: [],
    costUsd: 0,
    latencyMs: 0,
    finishReason: 'done',
    rawSseTape: [],
    ...over,
  };
}

function makeTi(toolName: string, over: Partial<ToolInvocationRow> = {}): ToolInvocationRow {
  return {
    toolName,
    argsJson: null,
    resultJson: null,
    costUsd: 0,
    latencyMs: 0,
    metadataJson: {},
    ...over,
  };
}

describe('tool_called', () => {
  it('passes when the tool appears in SSE tape', () => {
    const run = makeRun({
      turns: [makeTurn({ toolCalls: [{ name: 'harness:status', input: {} }] })],
    });
    expect(evaluateAsserts([{ kind: 'tool_called', name: 'harness:status' }], run)).toHaveLength(0);
  });

  it('passes when the tool appears only in PG telemetry', () => {
    const run = makeRun({
      toolInvocations: [makeTi('harness:status')],
    });
    expect(evaluateAsserts([{ kind: 'tool_called', name: 'harness:status' }], run)).toHaveLength(0);
  });

  it('tail-matches mcp__plugin__tool naming', () => {
    const run = makeRun({ toolInvocations: [makeTi('mcp__harness__status')] });
    expect(evaluateAsserts([{ kind: 'tool_called', name: 'harness:status' }], run)).toHaveLength(0);
  });

  it('flags when the tool was never called', () => {
    const v = evaluateAsserts([{ kind: 'tool_called', name: 'harness:status' }], makeRun());
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe('error');
  });

  it('counts SSE + PG without double-counting via tail match', () => {
    const run = makeRun({
      turns: [makeTurn({ toolCalls: [{ name: 'issues:list', input: {} }] })],
      toolInvocations: [makeTi('issues:list')],
    });
    expect(
      evaluateAsserts([{ kind: 'tool_called', name: 'issues:list', minTimes: 2 }], run),
    ).toHaveLength(0);
  });
});

describe('tool_not_called', () => {
  it('passes when forbidden tool is absent', () => {
    expect(evaluateAsserts([{ kind: 'tool_not_called', name: 'spawn' }], makeRun())).toHaveLength(0);
  });
  it('flags when forbidden tool is present', () => {
    const run = makeRun({ toolInvocations: [makeTi('harness:spawn')] });
    const v = evaluateAsserts([{ kind: 'tool_not_called', name: 'harness:spawn' }], run);
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe('error');
  });
});

describe('auto_fire_happened / auto_fire_did_not_happen', () => {
  it('auto_fire_happened passes when continue chain has matching trigger', () => {
    const run = makeRun({ continueChainRows: [makeChainRow({ trigger: 'continue' })] });
    expect(
      evaluateAsserts([{ kind: 'auto_fire_happened', trigger: 'continue' }], run),
    ).toHaveLength(0);
  });

  it('auto_fire_did_not_happen ignores reset rows', () => {
    const run = makeRun({ continueChainRows: [makeChainRow({ trigger: 'reset' })] });
    expect(evaluateAsserts([{ kind: 'auto_fire_did_not_happen' }], run)).toHaveLength(0);
  });

  it('auto_fire_did_not_happen flags continue / auto_fire_terminal', () => {
    const run = makeRun({ continueChainRows: [makeChainRow({ trigger: 'auto_fire_terminal' })] });
    expect(evaluateAsserts([{ kind: 'auto_fire_did_not_happen' }], run)).toHaveLength(1);
  });
});

describe('continue_chain_within_cap', () => {
  it('passes for a single short chain', () => {
    const rows = [
      makeChainRow({ chainId: 'A', turnIdx: 0, elapsedSecsInChain: 1 }),
      makeChainRow({ chainId: 'A', turnIdx: 1, elapsedSecsInChain: 2 }),
    ];
    const run = makeRun({ continueChainRows: rows });
    expect(evaluateAsserts([{ kind: 'continue_chain_within_cap', maxTurns: 5, maxSecs: 300 }], run)).toHaveLength(0);
  });

  it('flags when chain exceeds turn cap', () => {
    const rows = Array.from({ length: 6 }, (_, i) =>
      makeChainRow({ chainId: 'A', turnIdx: i, elapsedSecsInChain: i + 1 }),
    );
    const run = makeRun({ continueChainRows: rows });
    expect(
      evaluateAsserts([{ kind: 'continue_chain_within_cap', maxTurns: 5, maxSecs: 300 }], run),
    ).toHaveLength(1);
  });
});

describe('text_contains / text_excludes', () => {
  it('text_contains passes when pattern is in any turn', () => {
    const run = makeRun({ turns: [makeTurn({ assistantText: 'sheets is OK' })] });
    expect(evaluateAsserts([{ kind: 'text_contains', pattern: 'sheets' }], run)).toHaveLength(0);
  });
  it('text_excludes flags when banned pattern present', () => {
    const run = makeRun({ turns: [makeTurn({ assistantText: "I don't know" })] });
    expect(
      evaluateAsserts([{ kind: 'text_excludes', pattern: "I don't know" }], run),
    ).toHaveLength(1);
  });
});

describe('card_emitted', () => {
  it('passes when card kind appears', () => {
    const run = makeRun({
      turns: [makeTurn({ cards: [{ kind: 'ready', voiceAnswerable: true, options: [{ id: 'go', label: 'Go' }] }] })],
    });
    expect(evaluateAsserts([{ kind: 'card_emitted', cardKind: 'ready' }], run)).toHaveLength(0);
  });
  it('flags missing voiceAnswerable when required', () => {
    const run = makeRun({
      turns: [makeTurn({ cards: [{ kind: 'ready', voiceAnswerable: false }] })],
    });
    const v = evaluateAsserts(
      [{ kind: 'card_emitted', cardKind: 'ready', voiceAnswerable: true }],
      run,
    );
    expect(v.some((x) => x.severity === 'error')).toBe(true);
  });
});

describe('control_tag_present', () => {
  it('counts <continue/> across turns', () => {
    const run = makeRun({
      turns: [
        makeTurn({ controlTags: [{ tag: 'continue' }] }),
        makeTurn({ controlTags: [{ tag: 'continue' }, { tag: 'sleep' }] }),
      ],
    });
    expect(
      evaluateAsserts(
        [{ kind: 'control_tag_present', tag: 'continue', minCount: 2 }],
        run,
      ),
    ).toHaveLength(0);
  });
  it('flags over-cap', () => {
    const run = makeRun({
      turns: [makeTurn({ controlTags: [{ tag: 'continue' }, { tag: 'continue' }, { tag: 'continue' }] })],
    });
    const v = evaluateAsserts(
      [{ kind: 'control_tag_present', tag: 'continue', maxCount: 1 }],
      run,
    );
    expect(v.some((x) => x.severity === 'warn')).toBe(true);
  });
});

describe('cost_under / latency_under / finish_reason_is', () => {
  it('cost_under flags overrun', () => {
    const v = evaluateAsserts([{ kind: 'cost_under', usd: 0.1 }], makeRun({ totalCostUsd: 0.5 }));
    expect(v).toHaveLength(1);
  });
  it('finish_reason_is checks last turn', () => {
    const run = makeRun({ turns: [makeTurn({ finishReason: 'cap' })] });
    expect(evaluateAsserts([{ kind: 'finish_reason_is', expected: 'cap' }], run)).toHaveLength(0);
    expect(evaluateAsserts([{ kind: 'finish_reason_is', expected: 'done' }], run)).toHaveLength(1);
  });
});

function makeChainRow(over: Partial<ContinueChainRow> = {}): ContinueChainRow {
  return {
    chainId: 'C',
    turnIdx: 0,
    trigger: 'continue',
    startedAt: new Date(),
    elapsedSecsInChain: 0,
    wasCapped: false,
    capReason: null,
    ...over,
  };
}
