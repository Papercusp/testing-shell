/**
 * EI-336: the judge is catalog-blind — it was flagging real, in-catalog SU
 * tool names (`locks:acquire`, `coord:declare-intent`, ...) as "fabricated"
 * because it never received the target's actual tool-name registry, only its
 * own (incomplete) training-memory guess. That confident false-positive
 * flips a `severity: 'error'` finding, which hard-fails a run whose
 * deterministic asserts all passed (runner.ts's `hasErrorFinding`).
 *
 * This proves the fix end-to-end:
 *   1. `ChatTarget.toolNames` flows from the target into the judge's system
 *      prompt as a "Known tool registry" block (via runScenario → judgeRun).
 *   2. A target WITHOUT `toolNames` gets the hedging rule instead (no false
 *      confidence either way).
 *
 * Everything is in-memory: fake target, fake llmCall capturing the judge's
 * system prompt, no PG.
 */

import { describe, expect, it } from 'vitest';

import { runScenario } from '../runner';
import type {
  ChatSession,
  ChatTarget,
  LlmCallFn,
  LlmCallOpts,
  LlmCallResult,
  RunnerDeps,
  Scenario,
  SessionOptions,
  TurnInput,
  TurnResult,
} from '../index';

process.env.PAPERCUSP_LLM_TEST_SKIP_CLAIM = '1';

function makeScenario(over: Partial<Scenario> = {}): Scenario {
  return {
    id: 'known-tool-names-test',
    version: 1,
    target: 'fake',
    description: 'known tool names test',
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

function makeTarget(opts: {
  toolNames?: readonly string[];
  turn?: Partial<TurnResult>;
}): ChatTarget {
  return {
    id: 'fake',
    behaviors: [],
    ...(opts.toolNames ? { toolNames: opts.toolNames } : {}),
    async open(_o: SessionOptions): Promise<ChatSession> {
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
            ...opts.turn,
          };
        },
        async close() {},
      };
    },
  };
}

/** Captures every llmCall's system prompt so the test can inspect what the
 *  judge actually saw, while still returning a valid judge JSON payload.
 *  The sim-user's FIRST call must be a real `text` action (a `declare_success`
 *  opener ends the conversation with zero turns before the SUT ever replies,
 *  which the runner then treats as inconclusive — never reaching the judge). */
function makeCapturingLlmCall(
  seenSystemPrompts: string[],
  seenUserPrompts: string[] = [],
): LlmCallFn {
  let simCalls = 0;
  return async (opts: LlmCallOpts) => {
    const isJudge = (opts.system ?? '').includes('external reviewer');
    if (isJudge) {
      seenSystemPrompts.push(opts.system ?? '');
      seenUserPrompts.push(opts.messages.map((message) => message.content).join('\n'));
    }
    let json: unknown;
    if (isJudge) {
      json = { summary: 'nominal', scores: { quality: 5 }, findings: [], agrees_with_deterministic_asserts: true, novel_failures: [] };
    } else {
      simCalls += 1;
      json = simCalls === 1
        ? { thought: 'ask once', action: { kind: 'text', text: 'hi' } }
        : { thought: 'done', action: { kind: 'declare_success', reason: 'done' } };
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

function makeDeps(
  target: ChatTarget,
  seenSystemPrompts: string[],
  seenUserPrompts: string[] = [],
): RunnerDeps {
  return {
    llmCall: makeCapturingLlmCall(seenSystemPrompts, seenUserPrompts),
    getTarget: () => target,
  };
}

describe('judge knownToolNames grounding (EI-336)', () => {
  it('threads target.toolNames into the judge system prompt as a known-registry block', async () => {
    const seenSystemPrompts: string[] = [];
    const target = makeTarget({ toolNames: ['locks:acquire', 'coord:declare-intent', 'docs:get'] });
    await runScenario(makeScenario(), {}, makeDeps(target, seenSystemPrompts));

    expect(seenSystemPrompts).toHaveLength(1);
    const prompt = seenSystemPrompts[0];
    expect(prompt).toContain('Known tool registry');
    expect(prompt).toContain('locks:acquire');
    expect(prompt).toContain('coord:declare-intent');
    // Ground-truth block present ⇒ the hedge-only rule for catalog-less runs
    // must NOT also render (they're mutually exclusive branches).
    expect(prompt).not.toContain('NO ground-truth tool registry');
  });

  it('falls back to the hedging rule when the target declares no toolNames', async () => {
    const seenSystemPrompts: string[] = [];
    const target = makeTarget({});
    await runScenario(makeScenario(), {}, makeDeps(target, seenSystemPrompts));

    expect(seenSystemPrompts).toHaveLength(1);
    const prompt = seenSystemPrompts[0];
    expect(prompt).not.toContain('Known tool registry');
    expect(prompt).toContain('NO ground-truth tool registry');
  });

  it('renders bounded tool-result evidence into the judge transcript', async () => {
    const seenSystemPrompts: string[] = [];
    const seenUserPrompts: string[] = [];
    const target = makeTarget({
      toolNames: ['work_items:get'],
      turn: {
        assistantText: 'WI-200 is blocked.',
        toolCalls: [{ name: 'work_items:get', input: { id: 'WI-200' } }],
        toolResults: [{
          name: 'work_items:get',
          output: '{"ok":true,"state":"blocked","id":"WI-200"}',
          isError: false,
          truncated: false,
          sourceChars: 46,
        }],
      },
    });

    await runScenario(
      makeScenario(),
      {},
      makeDeps(target, seenSystemPrompts, seenUserPrompts),
    );

    expect(seenUserPrompts).toHaveLength(1);
    expect(seenUserPrompts[0]).toContain('**Tool results:**');
    expect(seenUserPrompts[0]).toContain('work_items:get [ok]');
    expect(seenUserPrompts[0]).toContain('state');
    expect(seenUserPrompts[0]).toContain('blocked');
    expect(seenUserPrompts[0]).toContain('WI-200');
  });
});
