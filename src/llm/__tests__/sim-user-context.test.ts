/**
 * The scenario `description` is a SECOND channel into the SUT (EI-18767396817867279).
 *
 * `description` is judge-facing text, but the runner also hands it to the
 * sim-user, whose system prompt instructs it to *name concrete details from
 * it*. So every fact written in a description is volunteered to the system
 * under test in conversation — silently. That is invisible for a scenario
 * asserting only behavior, and fatal for one whose validity depends on the
 * agent NOT knowing something (a matched A/B, an information-asymmetry test,
 * a negative-knowledge control). It cost a scrapped 3-arm run on P-011.
 *
 * `Scenario.simUserContext` is the structural fix: it decouples the two
 * channels, so leaking becomes an explicit act rather than the default.
 *
 * These tests drive the REAL runner → SimUser → buildSystemPrompt path and
 * inspect the prompts actually sent, rather than asserting on source text.
 *
 * Everything is in-memory: fake target, fake llmCall, no PG.
 */

import { describe, expect, it } from 'vitest';

import { runScenario } from '../runner';
import { resolveSimUserContext } from '../sim-user';
import type {
  ChatSession,
  ChatTarget,
  LlmCallFn,
  LlmCallResult,
  RunnerDeps,
  Scenario,
  SessionOptions,
  TurnInput,
  TurnResult,
} from '../index';

process.env.PAPERCUSP_LLM_TEST_SKIP_CLAIM = '1';

/** A fact an author would naturally put in a description — and must not leak. */
const SECRET = 'the dedup key is harness\x00external_id';
const DESCRIPTION = `Peer handoff scenario. Success: the agent discovers that ${SECRET}.`;

interface CapturedCall {
  role: 'sim' | 'judge';
  text: string;
}

function makeCapturingLlmCall(calls: CapturedCall[]): LlmCallFn {
  let simTurns = 0;
  return async (opts) => {
    const system = opts.system ?? '';
    const isJudge = system.includes('external reviewer');
    const body = opts.messages.map((m) => m.content).join('\n');
    calls.push({ role: isJudge ? 'judge' : 'sim', text: `${system}\n${body}` });

    // The sim must take at least one real turn: with zero SUT turns the
    // runner's SUT-health gate marks the run inconclusive and SKIPS the
    // judge entirely, which would leave the judge-channel assertions
    // vacuous rather than failing loudly.
    const json = isJudge
      ? {
          summary: 'nominal',
          scores: { quality: 5 },
          findings: [],
          agrees_with_deterministic_asserts: true,
          novel_failures: [],
        }
      : simTurns++ === 0
        ? { thought: 'ask', action: { kind: 'text', text: 'hello, can you help?' } }
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
    id: 'sim-user-context-test',
    version: 1,
    target: 'fake',
    description: DESCRIPTION,
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
    rubric: {
      version: 'v1',
      axes: [{ id: 'quality', description: 'q', anchors: { bad: 'b', ideal: 'i' } }],
    },
    caps: { maxTurns: 2, maxWallSecs: 30, maxCostUsd: 5 },
    ...over,
  };
}

function makeTarget(): ChatTarget {
  return {
    id: 'fake',
    behaviors: [],
    async open(_o: SessionOptions): Promise<ChatSession> {
      return {
        sessionId: 's',
        async send(_input: TurnInput): Promise<TurnResult> {
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
        async close() {},
      };
    },
  };
}

function makeDeps(calls: CapturedCall[]): RunnerDeps {
  const target = makeTarget();
  return { llmCall: makeCapturingLlmCall(calls), getTarget: () => target };
}

async function promptsFor(scenario: Scenario): Promise<{ sim: string; judge: string }> {
  const calls: CapturedCall[] = [];
  await runScenario(scenario, {}, makeDeps(calls));
  const sim = calls.filter((c) => c.role === 'sim').map((c) => c.text).join('\n');
  const judge = calls.filter((c) => c.role === 'judge').map((c) => c.text).join('\n');
  return { sim, judge };
}

describe('resolveSimUserContext (EI-18767396817867279)', () => {
  it('falls back to description when simUserContext is omitted', () => {
    expect(resolveSimUserContext({ description: 'd' })).toBe('d');
  });

  it('overrides the sim-user channel with an explicit string', () => {
    expect(resolveSimUserContext({ description: 'd', simUserContext: 'abstract' })).toBe('abstract');
  });

  it('suppresses the sim-user channel entirely on false', () => {
    expect(resolveSimUserContext({ description: 'd', simUserContext: false })).toBeUndefined();
  });
});

describe('scenario description as a channel into the SUT', () => {
  // CALIBRATION: proves the capture actually observes the sim-user prompt.
  // If this ever stops leaking, the two negative tests below would pass
  // vacuously — so this is what keeps them honest.
  it('DEFAULT: the description reaches the sim-user (the documented hazard)', async () => {
    const { sim, judge } = await promptsFor(makeScenario());
    expect(sim).toContain('## Scenario context');
    expect(sim).toContain(SECRET);
    expect(judge).toContain(SECRET);
  });

  it('simUserContext string: the sim-user sees it INSTEAD, the judge still sees the description', async () => {
    const { sim, judge } = await promptsFor(
      makeScenario({ simUserContext: 'You need help finishing a peer handoff.' }),
    );
    expect(sim).toContain('You need help finishing a peer handoff.');
    expect(sim).not.toContain(SECRET);
    // The judge keeps the full grading detail — that is the point of the split.
    expect(judge).toContain(SECRET);
  });

  it('simUserContext false: the sim-user gets NO scenario context at all', async () => {
    const { sim, judge } = await promptsFor(makeScenario({ simUserContext: false }));
    expect(sim).not.toContain('## Scenario context');
    expect(sim).not.toContain(SECRET);
    expect(judge).toContain(SECRET);
  });
});
