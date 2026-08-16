/**
 * EI-7597: a wedged transport/quota call inside the turn loop (sim-user's
 * next-action, the SUT's session.send) or the post-loop judge call must
 * surface as a bounded FAILURE, never hang the process silently past the
 * scenario's own declared `maxWallSecs`. Covers both `withTimeout` in
 * isolation and its wiring into the runner's turn loop / judge call.
 */

import { describe, expect, it, vi } from 'vitest';

import { LlmTestTimeoutError, runScenario, withTimeout } from '../runner';
import type {
  ChatSession,
  ChatTarget,
  LlmCallFn,
  LlmCallResult,
  RunnerDeps,
  Scenario,
  TurnInput,
  TurnResult,
} from '../index';

process.env.PAPERCUSP_LLM_TEST_SKIP_CLAIM = '1';

// ---------------------------------------------------------------------------
// withTimeout — unit coverage
// ---------------------------------------------------------------------------

describe('withTimeout', () => {
  it('resolves with the underlying value when it settles before the deadline', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000, 'label')).resolves.toBe('ok');
  });

  it('propagates a genuine rejection (not a timeout) unchanged', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000, 'label')).rejects.toThrow('boom');
  });

  it('rejects with LlmTestTimeoutError once the deadline elapses', async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise<never>(() => {});
      const p = withTimeout(never, 50, 'my-call');
      const assertion = expect(p).rejects.toBeInstanceOf(LlmTestTimeoutError);
      await vi.advanceTimersByTimeAsync(60);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects immediately when ms <= 0 (budget already exhausted)', async () => {
    await expect(withTimeout(new Promise(() => {}), 0, 'label')).rejects.toBeInstanceOf(LlmTestTimeoutError);
    await expect(withTimeout(new Promise(() => {}), -5, 'label')).rejects.toBeInstanceOf(LlmTestTimeoutError);
  });
});

// ---------------------------------------------------------------------------
// Runner wiring — a hung session.send / sim-user call must cap-breach, not hang
// ---------------------------------------------------------------------------

function makeFakeLlmCall(over?: { simHangs?: boolean }): LlmCallFn {
  return async (opts) => {
    const isJudge = (opts.system ?? '').includes('external reviewer');
    if (!isJudge && over?.simHangs) {
      return new Promise<never>(() => {}); // never resolves
    }
    const json = isJudge
      ? { summary: 'nominal', scores: { quality: 5 }, findings: [], agrees_with_deterministic_asserts: true, novel_failures: [] }
      : { thought: 'ask once then done', action: { kind: 'declare_success', reason: 'done' } };
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

function makeScenario(over: Partial<Scenario> = {}): Scenario {
  return {
    id: 'op-timeout-test',
    version: 1,
    target: 'fake',
    description: 'timeout guard test',
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
    asserts: [],
    rubric: { version: 'v1', axes: [{ id: 'quality', description: 'q', anchors: { bad: 'b', ideal: 'i' } }] },
    caps: { maxTurns: 2, maxWallSecs: 1, maxCostUsd: 5 },
    ...over,
  };
}

function makeHangingTarget(): ChatTarget {
  return {
    id: 'fake',
    behaviors: [],
    async open(): Promise<ChatSession> {
      return {
        sessionId: 's',
        async send(_input: TurnInput): Promise<TurnResult> {
          return new Promise<never>(() => {}); // never resolves — simulates a wedged transport
        },
        async close() {},
      };
    },
  };
}

function makeNormalTarget(): ChatTarget {
  return {
    id: 'fake',
    behaviors: [],
    async open(): Promise<ChatSession> {
      return {
        sessionId: 's',
        async send(_input: TurnInput): Promise<TurnResult> {
          return {
            assistantText: 'ok?',
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

function makeDeps(target: ChatTarget, over: Partial<RunnerDeps> = {}): RunnerDeps {
  return {
    llmCall: makeFakeLlmCall(),
    getTarget: () => target,
    ...over,
  };
}

describe('runner turn-loop timeout guard (EI-7597)', () => {
  it('cap-breaches (wallclock) instead of hanging when session.send never resolves', async () => {
    vi.useFakeTimers();
    try {
      const scenario = makeScenario({
        // Scripted trigger on turn 0 skips sim-user entirely, driving straight
        // into the guarded session.send call.
        triggers: [{ on: 'after_turn', param: 0, fire: 'user_message' }],
      });
      const promise = runScenario(scenario, {}, makeDeps(makeHangingTarget()));
      const assertion = expect(promise).resolves.toMatchObject({
        runs: [
          {
            status: 'errored',
            summary: {
              finishReason: 'cap_breach',
              capBreaches: ['wallclock'],
            },
          },
        ],
      });
      // Advance well past the 1s maxWallSecs deadline.
      await vi.advanceTimersByTimeAsync(1500);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('cap-breaches (wallclock) instead of hanging when sim-user.nextAction never resolves', async () => {
    vi.useFakeTimers();
    try {
      const scenario = makeScenario();
      const deps = makeDeps(makeNormalTarget(), { llmCall: makeFakeLlmCall({ simHangs: true }) });
      const promise = runScenario(scenario, {}, deps);
      const assertion = expect(promise).resolves.toMatchObject({
        runs: [
          {
            status: 'errored',
            summary: {
              finishReason: 'cap_breach',
              capBreaches: ['wallclock'],
            },
          },
        ],
      });
      await vi.advanceTimersByTimeAsync(1500);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('a normal (fast) run is unaffected by the timeout guard', async () => {
    const scenario = makeScenario();
    const report = await runScenario(scenario, {}, makeDeps(makeNormalTarget()));
    expect(report.runs[0].summary.finishReason).toBe('completed');
    expect(report.runs[0].summary.capBreaches).toEqual([]);
  });
});
