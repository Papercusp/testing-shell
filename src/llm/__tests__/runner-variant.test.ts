/**
 * Eval variant knob (test-gym-apiary-framework-2026-06-09 P-001).
 *
 * Proves the runner:
 *   1. delivers `RunnerOpts.variant` to `target.open()` verbatim,
 *   2. stamps `RunSummary.variantId` on the run (compare/select attribution),
 *   3. REFUSES a variant against a target that doesn't declare
 *      `supportsVariants` (loud, not silently-baseline) — and still runs the
 *      setup cleanup on that refusal path,
 *   4. baseline (no variant) runs exactly as before: no variant delivered,
 *      no variantId stamped, unsupporting targets fine.
 *
 * Everything is in-memory: fake target, fake llmCall, no PG.
 */

import { describe, expect, it } from 'vitest';

import { runScenario } from '../runner';
import type {
  ChatSession,
  ChatTarget,
  LlmCallFn,
  LlmCallResult,
  RunnerDeps,
  Scenario,
  ScenarioVariant,
  SessionOptions,
  TurnInput,
  TurnResult,
} from '../index';

process.env.PAPERCUSP_LLM_TEST_SKIP_CLAIM = '1';

const VARIANT: ScenarioVariant = {
  id: 'scout-idea-42',
  promptOverlay: 'Always answer in haiku.',
  configDelta: { sutModel: 'claude-haiku-4-5' },
};

function makeFakeLlmCall(): LlmCallFn {
  return async (opts) => {
    const isJudge = (opts.system ?? '').includes('external reviewer');
    const json = isJudge
      ? { summary: 'nominal', scores: { quality: 5 }, findings: [], agrees_with_deterministic_asserts: true, novel_failures: [] }
      : { thought: 'done', action: { kind: 'declare_success', reason: 'done' } };
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
    id: 'variant-knob-test',
    version: 1,
    target: 'fake',
    description: 'variant knob test',
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
    caps: { maxTurns: 2, maxWallSecs: 30, maxCostUsd: 5 },
    ...over,
  };
}

function makeTarget(opts: { supportsVariants?: boolean; seenOpens: SessionOptions[] }): ChatTarget {
  return {
    id: 'fake',
    behaviors: [],
    ...(opts.supportsVariants !== undefined && { supportsVariants: opts.supportsVariants }),
    async open(o: SessionOptions): Promise<ChatSession> {
      opts.seenOpens.push(o);
      return {
        sessionId: 's',
        async send(_input: TurnInput): Promise<TurnResult> {
          return {
            assistantText: 'ok',
            toolCalls: [],
            toolResults: [],
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

describe('runner variant knob (P-001)', () => {
  it('delivers the variant to target.open and stamps variantId on the summary', async () => {
    const seenOpens: SessionOptions[] = [];
    const target = makeTarget({ supportsVariants: true, seenOpens });
    const report = await runScenario(makeScenario(), { variant: VARIANT }, makeDeps(target));
    expect(seenOpens).toHaveLength(1);
    expect(seenOpens[0].variant).toEqual(VARIANT);
    expect(seenOpens[0].sutModel).toBe('claude-sonnet-4-6');
    expect(report.runs[0].summary.variantId).toBe('scout-idea-42');
  });

  it('refuses a variant against a target without supportsVariants — and still cleans up setup', async () => {
    const seenOpens: SessionOptions[] = [];
    const target = makeTarget({ seenOpens }); // no supportsVariants
    const events: string[] = [];
    const deps = makeDeps(target, {
      applySetup: async () => {
        events.push('setup');
        return async () => {
          events.push('cleanup');
        };
      },
    });
    await expect(
      runScenario(
        makeScenario({ setup: { mem0: [{ kind: 'project', body: 'x' }] } }),
        { variant: VARIANT },
        deps,
      ),
    ).rejects.toThrow(/variant_unsupported.*'fake'.*'scout-idea-42'/);
    expect(seenOpens).toHaveLength(0); // refused BEFORE open
    expect(events).toEqual(['setup', 'cleanup']);
  });

  it('baseline run: no variant delivered, no variantId, unsupporting target fine', async () => {
    const seenOpens: SessionOptions[] = [];
    const target = makeTarget({ seenOpens }); // no supportsVariants
    const report = await runScenario(makeScenario(), {}, makeDeps(target));
    expect(seenOpens).toHaveLength(1);
    expect(seenOpens[0].variant).toBeUndefined();
    expect(report.runs[0].summary.variantId).toBeUndefined();
  });

  it('delivers an explicit resolved SUT model to target.open', async () => {
    const seenOpens: SessionOptions[] = [];
    const target = makeTarget({ seenOpens });
    await runScenario(makeScenario(), { sutModel: 'gpt-5.6-sol:xhigh' }, makeDeps(target));
    expect(seenOpens[0].sutModel).toBe('gpt-5.6-sol:xhigh');
  });

  it('variant repeats across the whole matrix (every run is the same candidate)', async () => {
    const seenOpens: SessionOptions[] = [];
    const target = makeTarget({ supportsVariants: true, seenOpens });
    const report = await runScenario(
      makeScenario({ runMatrix: { repeat: 2 } }),
      { variant: VARIANT },
      makeDeps(target),
    );
    expect(seenOpens).toHaveLength(2);
    expect(seenOpens.every((o) => o.variant?.id === 'scout-idea-42')).toBe(true);
    expect(report.runs.every((r) => r.summary.variantId === 'scout-idea-42')).toBe(true);
  });
});
