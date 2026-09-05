/**
 * P-071: runner store-persistence seam.
 *
 * Proves `runScenario` drives a turn through an injected fake ChatTarget +
 * fake llmCall, and — when a `store` is injected — calls
 * `store.persistRunReport(report, rubricVersion, scenarioHash)` exactly once
 * at end-of-run with the aggregate RunReport. Also proves the backward-compat
 * path: no store → no persist, runner still completes.
 *
 * Everything is in-memory: no PG, no real model, no operator target. This is
 * the seam contract the operator (and any borrower) implements later.
 */

import { describe, expect, it } from 'vitest';

import { runScenario, type RunReport } from '../runner';
import type {
  ChatSession,
  ChatTarget,
  LlmCallFn,
  LlmCallResult,
  LlmTestStore,
  RunnerDeps,
  Scenario,
  TurnInput,
  TurnResult,
} from '../index';

// Skip the claim ledger entirely — no store injected by default.
process.env.PAPERCUSP_LLM_TEST_SKIP_CLAIM = '1';

// -----------------------------------------------------------------------------
// Fakes
// -----------------------------------------------------------------------------

/** A fake llmCall: the sim-user gets a single "declare_success" action; the
 *  judge (only reached if a turn runs) returns a trivially-passing rubric. */
function makeFakeLlmCall(): { fn: LlmCallFn; calls: number } {
  const state = { calls: 0 };
  const fn: LlmCallFn = async (opts) => {
    state.calls++;
    const isJudge = (opts.system ?? '').includes('external reviewer');
    const json = isJudge
      ? { summary: 'nominal', scores: { quality: 5 }, findings: [], agrees_with_deterministic_asserts: true, novel_failures: [] }
      : { thought: 'I have what I need.', action: { kind: 'declare_success', reason: 'done' } };
    const result: LlmCallResult = {
      text: JSON.stringify(json),
      json,
      inputTokens: 10,
      outputTokens: 10,
      costUsd: 0,
      raw: null,
    };
    return result;
  };
  return { fn, calls: state.calls } as unknown as { fn: LlmCallFn; calls: number };
}

/** A fake ChatTarget that returns one canned assistant turn per send(). */
function makeFakeTarget(sends: { value: number; inputs: TurnInput[] }): ChatTarget {
  return {
    id: 'fake',
    behaviors: [],
    async open(): Promise<ChatSession> {
      return {
        sessionId: 'fake-session',
        async send(input: TurnInput): Promise<TurnResult> {
          sends.value++;
          sends.inputs.push(input);
          const turn: TurnResult = {
            assistantText: 'Here you go.',
            toolCalls: [],
            toolResults: [],
            cards: [],
            controlTags: [],
            costUsd: 0,
            latencyMs: 5,
            finishReason: 'done',
            rawSseTape: [],
          };
          return turn;
        },
        async close() {
          /* no-op */
        },
      };
    },
  };
}

/** A fake in-memory store recording every persistRunReport call. */
function makeFakeStore(): { store: LlmTestStore; calls: Array<{ report: RunReport; rubricVersion: string; scenarioHash: string }> } {
  const calls: Array<{ report: RunReport; rubricVersion: string; scenarioHash: string }> = [];
  const store: LlmTestStore = {
    async persistRunReport(report, rubricVersion, scenarioHash) {
      calls.push({ report, rubricVersion, scenarioHash });
    },
  };
  return { store, calls };
}

function makeScenario(): Scenario {
  return {
    id: 'fake-S01-store-seam',
    version: 1,
    target: 'fake',
    description: 'A fake scenario exercising the runner store-persistence seam end to end.',
    persona: {
      verbosity: 'terse',
      politeness: 'neutral',
      clarification: 'never_clarifies',
      goalClarity: 'precise',
      interrupts: false,
      modality: 'text',
    },
    goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
    asserts: [],
    rubric: {
      version: '1.0.0',
      axes: [{ id: 'quality', description: 'overall quality', anchors: { bad: 'broken', ideal: 'perfect' } }],
    },
    caps: { maxTurns: 3, maxWallSecs: 30, maxCostUsd: 1 },
  };
}

function makeDeps(over: Partial<RunnerDeps> = {}): { deps: RunnerDeps; sends: { value: number; inputs: TurnInput[] } } {
  const { fn } = makeFakeLlmCall();
  const sends = { value: 0, inputs: [] as TurnInput[] };
  const target = makeFakeTarget(sends);
  const deps: RunnerDeps = {
    llmCall: fn,
    getTarget: (id: string) => {
      if (id !== 'fake') throw new Error(`unknown target ${id}`);
      return target;
    },
    ...over,
  };
  return { deps, sends };
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('runScenario — store persistence seam (P-071)', () => {
  it('drives at least one turn through the injected target', async () => {
    // Force a turn: a scripted trigger fires before the sim-user declares
    // success, so the fake target's send() is exercised.
    const scenario = makeScenario();
    scenario.triggers = [{ on: 'after_turn', fire: 'user_message', param: 0 }];
    const { deps, sends } = makeDeps();

    const report = await runScenario(scenario, {}, deps);

    expect(sends.value).toBeGreaterThanOrEqual(1);
    expect(report.scenarioId).toBe('fake-S01-store-seam');
    expect(report.runs).toHaveLength(1);
  });

  it('appends scripted trigger text as a deterministic user turn', async () => {
    const scenario = makeScenario();
    scenario.triggers = [{ on: 'after_turn', fire: 'user_message', param: 0, text: 'scripted follow-up' }];
    const { deps, sends } = makeDeps();

    await runScenario(scenario, {}, deps);

    expect(sends.inputs[0].trigger).toBe('user_message');
    expect(sends.inputs[0].messages).toContainEqual({ role: 'user', content: 'scripted follow-up' });
  });

  it('runs a later scripted trigger before sim-user can declare success', async () => {
    const scenario = makeScenario();
    scenario.triggers = [
      { on: 'after_turn', fire: 'user_message', param: 0, text: 'first scripted turn' },
      { on: 'after_turn', fire: 'user_message', param: 1, text: 'second scripted turn' },
    ];
    const { deps, sends } = makeDeps();

    await runScenario(scenario, {}, deps);

    expect(sends.value).toBe(2);
    expect(sends.inputs[1].trigger).toBe('user_message');
    expect(sends.inputs[1].messages).toContainEqual({ role: 'user', content: 'second scripted turn' });
  });

  it('records sim-user evidence on the SUT turn and exposes it to the judge', async () => {
    let simCalls = 0;
    const judgePrompts: string[] = [];
    const llmCall: LlmCallFn = async (opts) => {
      const isJudge = (opts.system ?? '').includes('external reviewer');
      if (isJudge) judgePrompts.push(opts.messages[0]?.content ?? '');
      const json = isJudge
        ? { summary: 'nominal', scores: { quality: 5 }, findings: [], agrees_with_deterministic_asserts: true, novel_failures: [] }
        : simCalls++ === 0
          ? { thought: 'approval needed', action: { kind: 'text', text: 'Please approve this write.' } }
          : { thought: 'done', action: { kind: 'declare_success', reason: 'done' } };
      return {
        text: JSON.stringify(json),
        json,
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0,
        raw: null,
      };
    };
    const { deps } = makeDeps({ llmCall });

    const report = await runScenario(makeScenario(), {}, deps);
    const run = report.runs[0];
    expect(run?.summary.turns[0]).toMatchObject({
      userText: 'Please approve this write.',
      simThought: 'approval needed',
      simKind: 'text',
    });
    expect(run?.simHistory).toEqual([
      { who: 'sim', action: { kind: 'text', thought: 'approval needed', text: 'Please approve this write.' } },
      expect.objectContaining({ who: 'sut' }),
      { who: 'sim', action: { kind: 'declare_success', thought: 'done', reason: 'done' } },
    ]);
    expect(judgePrompts[0]).toContain('Please approve this write.');
  });


  it('calls store.persistRunReport once with the aggregate report when a store is injected', async () => {
    const scenario = makeScenario();
    const { store, calls } = makeFakeStore();
    const { deps } = makeDeps({ store });

    const report = await runScenario(scenario, {}, deps);

    expect(calls).toHaveLength(1);
    expect(calls[0].report).toBe(report);
    expect(calls[0].rubricVersion).toBe('1.0.0');
    expect(typeof calls[0].scenarioHash).toBe('string');
    expect(calls[0].scenarioHash.length).toBeGreaterThan(0);
  });

  it('does not persist (and still completes) when no store is injected', async () => {
    const scenario = makeScenario();
    const { deps } = makeDeps(); // no store

    const report = await runScenario(scenario, {}, deps);

    // No throw, a real report came back. (There is no store to assert against;
    // the absence of a crash is the backward-compat guarantee.)
    expect(report.runs).toHaveLength(1);
    expect(['pass', 'fail', 'preview', 'errored']).toContain(report.verdict);
  });
});
