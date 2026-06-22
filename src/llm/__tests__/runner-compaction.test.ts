/**
 * Compaction seam (agent-tool-delta-protocol-2026-06-22 P-006 / D-008).
 *
 * Two layers:
 *   1. `applyCompaction` is PURE — replaces wire messages [0, upTo) with one
 *      lossy summary block, preserves the tail, clamps upTo, defaults role +
 *      summary text.
 *   2. The runner WIRES it: before `compactionPolicy.beforeTurn` (and before
 *      that turn's user message is appended) the history threaded into
 *      `session.send` is the rewritten one — the base turns are gone — and it
 *      stays compacted for later turns. No policy ⇒ full verbatim history.
 *
 * Everything is in-memory: a fake target that CAPTURES each turn's
 * `input.messages`, a counter-driven fake sim/judge llmCall. No PG, no model.
 */

import { describe, expect, it } from 'vitest';

import { applyCompaction, DEFAULT_COMPACTION_SUMMARY, runScenario } from '../runner';
import type {
  ChatSession,
  ChatTarget,
  CompactionPolicy,
  LlmCallFn,
  LlmCallResult,
  RunnerDeps,
  Scenario,
  TurnInput,
  TurnResult,
} from '../index';

process.env.PAPERCUSP_LLM_TEST_SKIP_CLAIM = '1';

type WireMsg = { role: 'user' | 'assistant' | 'system'; content: string };

// =============================================================================
// 1. Pure helper
// =============================================================================

describe('applyCompaction (pure)', () => {
  const base: WireMsg[] = [
    { role: 'user', content: 'U0 list the items' },
    { role: 'assistant', content: 'A0 here are A,B,C,D,E' },
    { role: 'user', content: 'U1 what changed' },
  ];

  it('replaces [0, upTo) with one default summary and keeps the tail', () => {
    const out = applyCompaction(base, { beforeTurn: 1, upTo: 2 });
    expect(out).toEqual([
      { role: 'user', content: DEFAULT_COMPACTION_SUMMARY },
      { role: 'user', content: 'U1 what changed' },
    ]);
    // The evicted base content is gone.
    expect(JSON.stringify(out)).not.toContain('A,B,C,D,E');
    expect(JSON.stringify(out)).not.toContain('U0 list the items');
  });

  it('honors a custom summary string and summaryRole', () => {
    const out = applyCompaction(base, {
      beforeTurn: 1,
      upTo: 2,
      summary: '[compacted: prior list summarized]',
      summaryRole: 'assistant',
    });
    expect(out[0]).toEqual({ role: 'assistant', content: '[compacted: prior list summarized]' });
    expect(out).toHaveLength(2);
  });

  it('is a no-op (copy) when upTo is 0', () => {
    const out = applyCompaction(base, { beforeTurn: 1, upTo: 0 });
    expect(out).toEqual(base);
    expect(out).not.toBe(base); // a fresh array, not the input
  });

  it('clamps upTo to the history length (compacts everything)', () => {
    const out = applyCompaction(base, { beforeTurn: 9, upTo: 999 });
    expect(out).toEqual([{ role: 'user', content: DEFAULT_COMPACTION_SUMMARY }]);
  });

  it('does not mutate the input array', () => {
    const copy = base.map((m) => ({ ...m }));
    applyCompaction(base, { beforeTurn: 1, upTo: 2 });
    expect(base).toEqual(copy);
  });
});

// =============================================================================
// 2. Runner wiring
// =============================================================================

/**
 * A sim/judge fake: the judge (system contains 'external reviewer') returns a
 * nominal score; the sim-user emits `text` actions for the first `textTurns`
 * turns, then `declare_success`. Drives a deterministic N-turn conversation.
 */
function makeFakeLlmCall(textTurns: number): LlmCallFn {
  let simCalls = 0;
  return async (opts) => {
    const isJudge = (opts.system ?? '').includes('external reviewer');
    let json: unknown;
    if (isJudge) {
      json = { summary: 'nominal', scores: { quality: 5 }, findings: [], agrees_with_deterministic_asserts: true, novel_failures: [] };
    } else {
      const n = simCalls++;
      json =
        n < textTurns
          ? { thought: 't', action: { kind: 'text', text: `SIM_TURN_${n}` } }
          : { thought: 't', action: { kind: 'declare_success', reason: 'done' } };
    }
    const result: LlmCallResult = {
      text: JSON.stringify(json),
      json,
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
      raw: null,
    };
    return result;
  };
}

/** Fake target that records the `input.messages` it was handed each send. */
function makeCapturingTarget(captured: WireMsg[][]): ChatTarget {
  return {
    id: 'fake',
    behaviors: [],
    async open(): Promise<ChatSession> {
      let turn = 0;
      return {
        sessionId: 's',
        async send(input: TurnInput): Promise<TurnResult> {
          captured.push(input.messages.map((m) => ({ ...m })));
          const t = turn++;
          return {
            assistantText: `ASSISTANT_TURN_${t}`,
            toolCalls: [],
            cards: [],
            controlTags: [],
            costUsd: 0,
            latencyMs: 1,
            finishReason: 'done',
            rawSseTape: [],
          };
        },
        async close() {},
      };
    },
  };
}

function makeScenario(over: Partial<Scenario> = {}): Scenario {
  return {
    id: 'compaction-test',
    version: 1,
    target: 'fake',
    description: 'compaction seam test',
    persona: {
      id: 'p',
      description: 'd',
      traits: {
        verbosity: 'terse',
        politeness: 'neutral',
        clarification: 'never_clarifies',
        goalClarity: 'precise',
        interrupts: false,
        modality: 'text',
      },
    },
    goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
    asserts: [{ kind: 'cost_under', usd: 10 }],
    rubric: { version: 'v1', axes: [{ id: 'quality', description: 'q', anchors: { bad: 'b', ideal: 'i' } }] },
    caps: { maxTurns: 4, maxWallSecs: 30, maxCostUsd: 5 },
    ...over,
  };
}

function makeDeps(target: ChatTarget, llmCall: LlmCallFn): RunnerDeps {
  return { llmCall, getTarget: () => target };
}

describe('runner compaction seam wiring', () => {
  it('compacts the wire history before the designated turn and keeps it compacted', async () => {
    const captured: WireMsg[][] = [];
    const policy: CompactionPolicy = { beforeTurn: 1, upTo: 2 };
    // 3 text turns then success → sends on turns 0,1,2.
    await runScenario(
      makeScenario({ compactionPolicy: policy }),
      {},
      makeDeps(makeCapturingTarget(captured), makeFakeLlmCall(3)),
    );

    expect(captured.length).toBeGreaterThanOrEqual(2);

    // Turn 0: full verbatim history — just the first user message.
    expect(captured[0]).toEqual([{ role: 'user', content: 'SIM_TURN_0' }]);

    // Turn 1: compaction fired. The leading [0,2) (turn-0 user + assistant) is
    // replaced by ONE summary block, then this turn's user message follows.
    expect(captured[1][0]).toEqual({ role: 'user', content: DEFAULT_COMPACTION_SUMMARY });
    expect(captured[1][captured[1].length - 1]).toEqual({ role: 'user', content: 'SIM_TURN_1' });
    const turn1Json = JSON.stringify(captured[1]);
    expect(turn1Json).not.toContain('SIM_TURN_0'); // base user evicted
    expect(turn1Json).not.toContain('ASSISTANT_TURN_0'); // base assistant evicted

    // Turn 2: STILL compacted (the rewrite is permanent) — exactly one summary.
    const turn2 = captured[2];
    expect(turn2.filter((m) => m.content === DEFAULT_COMPACTION_SUMMARY)).toHaveLength(1);
    expect(JSON.stringify(turn2)).not.toContain('SIM_TURN_0');
  });

  it('threads the full verbatim history when no policy is set', async () => {
    const captured: WireMsg[][] = [];
    await runScenario(makeScenario(), {}, makeDeps(makeCapturingTarget(captured), makeFakeLlmCall(3)));

    expect(captured.length).toBeGreaterThanOrEqual(2);
    // No summary block anywhere; turn 1 carries the verbatim turn-0 exchange.
    const allJson = JSON.stringify(captured);
    expect(allJson).not.toContain(DEFAULT_COMPACTION_SUMMARY);
    expect(JSON.stringify(captured[1])).toContain('SIM_TURN_0');
    expect(JSON.stringify(captured[1])).toContain('ASSISTANT_TURN_0');
  });
});
