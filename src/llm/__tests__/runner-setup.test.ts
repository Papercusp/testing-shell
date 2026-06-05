/**
 * `RunnerDeps.applySetup` seam (memory-backend-benchmark-2026-06-05 P-009).
 *
 * Proves the runner:
 *   1. applies scenario.setup BEFORE target.open() (so pre-turn
 *      recall/injection in the SUT sees the seeded state),
 *   2. runs the returned cleanup AFTER session.close() on the happy path,
 *   3. runs the cleanup even when target.open() throws,
 *   4. survives a scenario with setup but NO injected applySetup
 *      (warn-and-run-unseeded), and
 *   5. never lets a cleanup failure mask the run result.
 *
 * Everything is in-memory: fake target, fake llmCall, no PG.
 */

import { describe, expect, it, vi } from 'vitest';

import { runScenario } from '../runner';
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

function makeFakeLlmCall(): LlmCallFn {
  return async (opts) => {
    const isJudge = (opts.system ?? '').includes('external reviewer');
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
    id: 'op-setup-test',
    version: 1,
    target: 'fake',
    description: 'setup seam test',
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
    setup: { mem0: [{ kind: 'project', body: 'seeded fact' }] },
    asserts: [{ kind: 'cost_under', usd: 10 }],
    rubric: { version: 'v1', axes: [{ id: 'quality', description: 'q', anchors: { bad: 'b', ideal: 'i' } }] },
    caps: { maxTurns: 2, maxWallSecs: 30, maxCostUsd: 5 },
    ...over,
  };
}

function makeTarget(events: string[], opts: { openThrows?: boolean } = {}): ChatTarget {
  return {
    id: 'fake',
    behaviors: [],
    async open(): Promise<ChatSession> {
      events.push('open');
      if (opts.openThrows) throw new Error('open exploded');
      return {
        sessionId: 's',
        async send(_input: TurnInput): Promise<TurnResult> {
          events.push('send');
          return {
            assistantText: 'ok',
            toolCalls: [],
            cards: [],
            controlTags: [],
            costUsd: 0,
            latencyMs: 1,
            finishReason: 'done',
            rawSseTape: [],
          };
        },
        async close() {
          events.push('close');
        },
      };
    },
  };
}

function makeDeps(events: string[], target: ChatTarget, over: Partial<RunnerDeps> = {}): RunnerDeps {
  return {
    llmCall: makeFakeLlmCall(),
    getTarget: () => target,
    applySetup: async (setup, ctx) => {
      expect(ctx.runId).toBeTruthy();
      expect(setup.mem0?.length).toBe(1);
      events.push('setup');
      return async () => {
        events.push('cleanup');
      };
    },
    ...over,
  };
}

describe('runner applySetup seam', () => {
  it('applies setup before open and cleans up after close', async () => {
    const events: string[] = [];
    await runScenario(makeScenario(), {}, makeDeps(events, makeTarget(events)));
    expect(events.indexOf('setup')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('setup')).toBeLessThan(events.indexOf('open'));
    expect(events.indexOf('cleanup')).toBeGreaterThan(events.indexOf('close'));
    expect(events.filter((e) => e === 'cleanup')).toHaveLength(1);
  });

  it('runs cleanup when target.open throws', async () => {
    const events: string[] = [];
    await expect(
      runScenario(makeScenario(), {}, makeDeps(events, makeTarget(events, { openThrows: true }))),
    ).rejects.toThrow('open exploded');
    expect(events).toContain('setup');
    expect(events).toContain('cleanup');
  });

  it('warns and runs unseeded when setup is declared but no applySetup seam exists', async () => {
    const events: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const deps = makeDeps(events, makeTarget(events));
      delete (deps as Partial<RunnerDeps>).applySetup;
      const report = await runScenario(makeScenario(), {}, deps);
      expect(report.runs).toHaveLength(1);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('no applySetup seam'))).toBe(true);
      expect(events).not.toContain('setup');
    } finally {
      warn.mockRestore();
    }
  });

  it('a failing cleanup never masks the run result', async () => {
    const events: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const deps = makeDeps(events, makeTarget(events), {
        applySetup: async () => async () => {
          throw new Error('cleanup exploded');
        },
      });
      const report = await runScenario(makeScenario(), {}, deps);
      expect(report.runs).toHaveLength(1);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('setup cleanup failed'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('skips the seam entirely when the scenario has no setup', async () => {
    const events: string[] = [];
    const applySetup = vi.fn();
    const scenario = makeScenario();
    delete (scenario as Partial<Scenario>).setup;
    await runScenario(scenario, {}, makeDeps(events, makeTarget(events), { applySetup }));
    expect(applySetup).not.toHaveBeenCalled();
  });
});
