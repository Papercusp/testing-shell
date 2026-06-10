/**
 * Runner — orchestrates Scenario × Persona → SUT → Judge.
 *
 * Plan §3.4. Single run:
 *   1. target.open() → session
 *   2. simUser.nextAction(history) → text | choice | give_up | declare_success
 *   3. session.send(turnInput) → TurnResult (one assistant turn)
 *   4. apply post-turn triggers (auto-fire, silence-nudge)
 *   5. check goal / caps
 *   6. evaluate deterministic asserts + run judge
 *   7. persist RunSummary
 *
 * runMatrix: scenario declares N runs; each gets its own matrix_index.
 *
 * Decoupled: all host-coupled capabilities are injected via `RunnerDeps`
 * (see ./deps) — the LLM transport, the target registry, telemetry pulls,
 * the run-report store, and the parallel-runner claim ledger. The lib
 * itself imports nothing host-specific.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { evaluateAsserts } from './asserts/index';
import type { RunnerDeps } from './deps';
import { computeIdentityHash, computeScenarioHash } from './identity';
import { judgeRun, buildInconclusiveJudge } from './judge';
import { resolveJudgeModel } from './judges/registry';
import { lookupBlend } from './personas/blends';
import { resolvePersona } from './personas/traits';
import { SimUser, type SimAction } from './sim-user';
import type {
  CardEvent,
  ChatSession,
  JudgeResult,
  Persona,
  RunSummary,
  Scenario,
  ScenarioVariant,
  TurnInput,
  TurnResult,
  TurnTrigger,
  Violation,
} from './types';

export type { RunnerDeps } from './deps';

export interface RunnerOpts {
  /** Override SUT model — defaults to env or scenario default. */
  sutModel?: string;
  /** Override judge model — see §6.3 (must differ from SUT). */
  judgeModel?: string;
  /** Override sim-user model — defaults to Haiku per plan §9. */
  simModel?: string;
  /** Force matrix repeat count (CLI --no-matrix uses 1). */
  forceRepeat?: number;
  /** Seed for deterministic sampling (sim temp, judge temp 0). */
  seed?: number;
  /** Path to scenario source file (for hashing). Optional but recommended. */
  scenarioFilePath?: string;
  /**
   * Eval variant knob (test-gym-apiary-framework-2026-06-09 P-001): run this
   * scenario WITH the variant applied (prompt overlay / config delta) —
   * injected at runtime, never a committed scenario file per idea. The target
   * must declare `supportsVariants`; otherwise the run fails loudly (a
   * silently-ignored variant would mislabel a baseline run as the candidate).
   * Omit for the baseline run.
   */
  variant?: ScenarioVariant;
}

export interface RunReport {
  scenarioId: string;
  matrixGroupId?: string;
  runs: SingleRunReport[];
  /** Aggregate verdict across the matrix. */
  verdict: 'pass' | 'fail' | 'preview' | 'errored';
  /** Variance per axis across the matrix (stddev). */
  varianceByAxis: Record<string, number>;
  /** Variance-policy findings (e.g. 'inconsistent_behavior'). */
  varianceFindings: Violation[];
}

export interface SingleRunReport {
  summary: RunSummary;
  violations: Violation[];
  judge: import('./types').JudgeResult;
  status: 'passed' | 'failed' | 'errored';
}

const DEFAULT_SUT_MODEL = process.env.LLM_TEST_SUT_MODEL ?? 'claude-sonnet-4-6';
const HAIKU_SIM_DEFAULT = 'claude-haiku-4-5';

/**
 * Resolve the judge model when the caller doesn't pass one explicitly.
 *
 * Priority (highest wins):
 *   1. `LLM_TEST_JUDGE_MODEL` env — CI matrices + ad-hoc local override.
 *   2. `deps.resolveModels()?.judgeModel` — host config (e.g. the operator
 *      agent-config per-workspace user preference). Skipped when no resolver
 *      is injected.
 *   3. `resolveJudgeModel(sutModel).judge` — SUT-aware default from
 *      the registry (Plan §13 Q2 + §9 cost model).
 */
async function resolveJudgeDefault(sutModel: string, deps: RunnerDeps): Promise<string> {
  if (process.env.LLM_TEST_JUDGE_MODEL) return process.env.LLM_TEST_JUDGE_MODEL;
  if (deps.resolveModels) {
    try {
      const { judgeModel } = await deps.resolveModels();
      if (judgeModel && judgeModel.trim()) return judgeModel.trim();
    } catch {
      /* host config unreachable — fall through to registry */
    }
  }
  return resolveJudgeModel(sutModel).judge;
}

/**
 * Resolve the sim-user model when the caller doesn't pass one
 * explicitly.
 *
 * Priority (highest wins):
 *   1. `LLM_TEST_SIM_MODEL` env.
 *   2. `deps.resolveModels()?.simModel` — host config. Skipped when no
 *      resolver is injected.
 *   3. `claude-haiku-4-5` — plan §9 cost envelope (sim-user is the
 *      chattiest role; haiku keeps the matrix affordable).
 */
async function resolveSimDefault(deps: RunnerDeps): Promise<string> {
  if (process.env.LLM_TEST_SIM_MODEL) return process.env.LLM_TEST_SIM_MODEL;
  if (deps.resolveModels) {
    try {
      const { simModel } = await deps.resolveModels();
      if (simModel && simModel.trim()) return simModel.trim();
    } catch {
      /* host config unreachable — fall through */
    }
  }
  return HAIKU_SIM_DEFAULT;
}

export async function runScenario(
  scenario: Scenario,
  opts: RunnerOpts = {},
  deps: RunnerDeps,
): Promise<RunReport> {
  const sutModel = opts.sutModel ?? DEFAULT_SUT_MODEL;
  const judgeModel = opts.judgeModel ?? (await resolveJudgeDefault(sutModel, deps));
  const simModel = opts.simModel ?? (await resolveSimDefault(deps));

  if (sutModel === judgeModel) {
    console.warn(
      `[llm-testing] SUT model === judge model (${sutModel}). Plan §6.3 recommends they differ to avoid self-grading bias.`,
    );
  }

  const persona = resolvePersona(scenario.persona, lookupBlend);
  const scenarioHash = readScenarioHash(opts.scenarioFilePath);
  const matrixRepeat = opts.forceRepeat ?? scenario.runMatrix?.repeat ?? 1;
  const matrixGroupId = matrixRepeat > 1 ? randomUUID() : undefined;

  const runs: SingleRunReport[] = [];
  for (let i = 0; i < matrixRepeat; i++) {
    const report = await runOnce({
      scenario,
      persona,
      scenarioHash,
      sutModel,
      judgeModel,
      simModel,
      matrixGroupId,
      matrixIndex: matrixGroupId ? i : undefined,
      ...(opts.seed !== undefined && { seed: opts.seed }),
      ...(opts.variant !== undefined && { variant: opts.variant }),
    }, deps);
    runs.push(report);
  }

  const report = aggregate(scenario, matrixGroupId, runs);

  // P-071: optional end-of-run persistence. The CLI historically persisted
  // separately; with an injected store the runner persists once at the end.
  // Backward-compatible: no store → no persist.
  if (deps.store) {
    try {
      await deps.store.persistRunReport(report, scenario.rubric.version, scenarioHash);
    } catch (err) {
      console.warn(`[llm-testing] store.persistRunReport failed: ${(err as Error).message}`);
    }
  }

  return report;
}

interface OnceArgs {
  scenario: Scenario;
  persona: Persona;
  scenarioHash: string;
  sutModel: string;
  judgeModel: string;
  simModel: string;
  matrixGroupId?: string;
  matrixIndex?: number;
  /**
   * Optional seed; the Anthropic SDK has no seed parameter so we use
   * it as a determinism hint: sim-user temperature → 0, judge first
   * pass already 0 (unchanged), judge second pass also 0 instead of
   * 0.4. Means a re-run with the same seed should usually produce the
   * same trajectory (model-side nondeterminism still possible).
   */
  seed?: number;
  /** Eval variant to apply (P-001) — see RunnerOpts.variant. */
  variant?: ScenarioVariant;
}

async function runOnce(args: OnceArgs, deps: RunnerDeps): Promise<SingleRunReport> {
  const { scenario, persona, scenarioHash, sutModel, judgeModel, simModel } = args;
  const runId = randomUUID();

  const identityHash = computeIdentityHash({
    scenarioId: scenario.id,
    scenarioVersion: scenario.version,
    scenarioHash,
    personaId: persona.id,
    personaTraits: persona.traits,
    rubricVersion: scenario.rubric.version,
    sutModel,
    judgeModel,
  });

  // Claim this (scenario × identity × matrix-index) tuple so parallel
  // runners (--parallel >1, distributed CI, two devs sharing a DB)
  // don't duplicate spend. The claim store is injected (deps.claim);
  // skipped entirely when absent (the lib has no ledger of its own).
  const skipClaim = process.env.PAPERCUSP_LLM_TEST_SKIP_CLAIM === '1' || !deps.claim;
  let claimKey: string | null = null;
  const claimOwner = `${process.pid}/${runId.slice(0, 8)}`;
  if (!skipClaim && deps.claim) {
    try {
      const claim = await deps.claim.tryClaim({
        scenarioId: scenario.id,
        identityHash,
        matrixIndex: args.matrixIndex,
        ownerId: claimOwner,
        metadata: { sutModel, judgeModel, simModel },
      });
      if (!claim.ok) {
        // Another runner already owns this identity. Caller (the CLI
        // batch loop) treats a thrown skip-error as a soft skip rather
        // than a hard failure — see bin/llm-test.ts.
        throw new Error(
          `claim_busy: ${scenario.id} held by ${claim.holder.ownerId} until ${claim.holder.expiresAt.toISOString()}`,
        );
      }
      claimKey = claim.claimKey;
    } catch (err) {
      if ((err as Error).message?.startsWith('claim_busy')) throw err;
      console.warn(`[llm-testing] ledger unavailable (${(err as Error).message}); proceeding without claim.`);
    }
  }

  // Scenario setup (memory seeds, fixture rows) — applied BEFORE the session
  // opens so pre-turn recall/injection sees it; the returned cleanup runs in
  // the post-run finally so seeded state never outlives its run.
  let setupCleanup: import('./deps').SetupCleanup | undefined;
  if (scenario.setup) {
    if (deps.applySetup) {
      const c = await deps.applySetup(scenario.setup, { runId });
      if (c) setupCleanup = c;
    } else {
      console.warn(
        `[llm-testing] scenario '${scenario.id}' declares setup but no applySetup seam is injected — running UNSEEDED.`,
      );
    }
  }

  const target = deps.getTarget(scenario.target);
  // Variant gate (P-001): a target that can't APPLY the variant must not run
  // it — a silently-ignored overlay/delta would label a baseline run as the
  // candidate and an eval would compare baseline vs baseline.
  if (args.variant && !target.supportsVariants) {
    await runSetupCleanup(setupCleanup, scenario.id);
    throw new Error(
      `variant_unsupported: target '${target.id}' does not declare supportsVariants — ` +
        `cannot apply variant '${args.variant.id}' (it would be silently ignored)`,
    );
  }
  let session: ChatSession;
  try {
    session = await target.open({
      runId,
      workspaceMode: scenario.realWorkspace ? 'real' : 'isolated',
      transport: scenario.transport ?? 'http-sse',
      dispatchOverride: scenario.toolOverride,
      ...(args.variant !== undefined && { variant: args.variant }),
    });
  } catch (err) {
    // open() failed after setup applied — clean the seeds before rethrowing.
    await runSetupCleanup(setupCleanup, scenario.id);
    throw err;
  }

  const simUser = new SimUser({
    persona,
    goal: scenario.goal,
    model: simModel,
    llmCall: deps.llmCall,
    scenarioDescription: scenario.description,
    ...(args.seed !== undefined && { temperature: 0 }),
  });

  const startedAt = new Date();
  const turns: TurnResult[] = [];
  const simHistory: Array<
    | { who: 'sim'; action: SimAction }
    | { who: 'sut'; turn: TurnResult }
  > = [];
  const wireMessages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [];
  const capBreaches: string[] = [];

  const maxTurns = scenario.caps.maxTurns;
  const maxWallSecs = scenario.caps.maxWallSecs;
  const maxCostUsd = scenario.caps.maxCostUsd;
  const wallDeadlineMs = startedAt.getTime() + maxWallSecs * 1000;

  let totalCostUsd = 0;
  let finishReason: RunSummary['finishReason'] = 'completed';
  let openCards: CardEvent[] = [];
  let pendingTrigger: TurnTrigger | null = null;

  // Scenario-declared scripted triggers (§ScenarioTrigger).
  // `on: 'after_turn'` with `param: N` fires the trigger right before
  // turn N (0-indexed). Used by S09 to inject `generate_ideas` as the
  // first turn before sim-user gets a say. Consumed once per match.
  const scriptedTriggers = new Map<number, TurnTrigger>();
  for (const t of scenario.triggers ?? []) {
    if (t.on === 'after_turn' && typeof t.param === 'number') {
      scriptedTriggers.set(t.param, t.fire);
    } else if (t.on === 'silence' || t.on === 'at_secs') {
      // The runner drives turns synchronously, so 'silence' never
      // naturally occurs and 'at_secs' wallclock-deadlines aren't
      // perceivable without idle gaps. Faithful simulator approximation:
      // fire the trigger at turn 0, before sim-user's first prompt.
      // The operator-converse route receives the trigger value and
      // behaves as if the named condition fired.
      if (!scriptedTriggers.has(0)) {
        scriptedTriggers.set(0, t.fire);
      }
    }
  }

  try {
    for (let turnIdx = 0; turnIdx < maxTurns; turnIdx++) {
      if (Date.now() > wallDeadlineMs) {
        capBreaches.push('wallclock');
        finishReason = 'cap_breach';
        break;
      }
      // Cap-breach is the real spend so far, not just SUT-side.
      // operator-converse's `done` event always emits costUsd:0, so
      // SUT cost is always 0 — sim-user is the real spender per turn.
      // (Judge cost lands once at end-of-run, so it doesn't gate the
      // per-turn loop; the loop's job is preventing runaway sim/SUT.)
      if (totalCostUsd + simUser.costUsd > maxCostUsd) {
        capBreaches.push('cost');
        finishReason = 'cap_breach';
        break;
      }

      let trigger: TurnTrigger;
      let turnMeta: Record<string, unknown> = { modality: persona.traits.modality };

      const scripted = scriptedTriggers.get(turnIdx);
      if (scripted) {
        trigger = scripted;
        scriptedTriggers.delete(turnIdx);
      } else if (pendingTrigger) {
        trigger = pendingTrigger;
        pendingTrigger = null;
      } else {
        // Ask sim-user what to do.
        const action = await simUser.nextAction({
          history: simHistory,
          cards: openCards,
          turnsRemaining: maxTurns - turnIdx,
        });
        simHistory.push({ who: 'sim', action });

        if (action.kind === 'give_up') {
          finishReason = 'aborted';
          break;
        }
        if (action.kind === 'declare_success') {
          finishReason = 'completed';
          break;
        }

        if (action.kind === 'text') {
          wireMessages.push({ role: 'user', content: action.text });
          trigger = 'user_message';
        } else {
          // choice
          wireMessages.push({
            role: 'user',
            content: `[card ${action.cardId} → ${action.optionId}]${action.freeText ? `: ${action.freeText}` : ''}`,
          });
          trigger = 'user_says_ready';
          turnMeta.cardId = action.cardId;
          turnMeta.optionId = action.optionId;
        }
      }

      // Drive one assistant turn.
      const input: TurnInput = {
        messages: wireMessages.slice(),
        trigger,
        meta: turnMeta,
      };

      const result = await session.send(input);
      turns.push(result);
      simHistory.push({ who: 'sut', turn: result });
      wireMessages.push({ role: 'assistant', content: result.assistantText });
      totalCostUsd += result.costUsd;
      openCards = result.cards;

      if (result.finishReason === 'error') {
        finishReason = 'errored';
        break;
      }

      // Auto-fire heuristic: if the assistant emits a `<continue/>` tag,
      // schedule an auto-fire continue turn. Same for terminal '?'.
      if (result.controlTags.some((c) => c.tag === 'continue')) {
        pendingTrigger = 'continue';
      } else if (endsWithQuestion(result.assistantText)) {
        // The real provider triggers a 'user_says_ready' here in V8 active
        // mode. The runner replicates that for deterministic asserts.
        // Sim-user gets the next say so it can also choose to answer the
        // question directly — we let sim-user run first (no auto-fire here).
      }
    }
    if (finishReason === 'completed' && turns.length === maxTurns) {
      capBreaches.push('turns');
      finishReason = 'cap_breach';
    }
  } finally {
    await session.close();
    await runSetupCleanup(setupCleanup, scenario.id);
  }

  const finishedAt = new Date();
  const uiClientId = `llm-testing/${runId}`;
  let toolInvocations: RunSummary['toolInvocations'] = [];
  let continueChainRows: RunSummary['continueChainRows'] = [];
  if (deps.telemetry) {
    try {
      [toolInvocations, continueChainRows] = await Promise.all([
        deps.telemetry.pullToolInvocations(uiClientId),
        deps.telemetry.pullContinueChainRows(uiClientId),
      ]);
    } catch (err) {
      // Telemetry pull is best-effort — a PG hiccup shouldn't crash the run
      // when we already have the SSE-side data. Asserts that depend on
      // PG rows will surface their own miss; this just records the warning.
      console.warn(`[llm-testing] telemetry pull failed: ${(err as Error).message}`);
    }
  }
  const summary: RunSummary = {
    runId,
    scenarioId: scenario.id,
    scenarioVersion: scenario.version,
    identityHash,
    matrixGroupId: args.matrixGroupId,
    matrixIndex: args.matrixIndex,
    sutModel,
    judgeModel,
    personaId: persona.id,
    personaTraits: persona.traits,
    ...(args.variant !== undefined && { variantId: args.variant.id }),
    workspaceMode: scenario.realWorkspace ? 'real' : 'isolated',
    transportMode: scenario.transport ?? 'http-sse',
    turns,
    toolInvocations,
    continueChainRows,
    totalCostUsd,
    startedAt,
    finishedAt,
    finishReason,
    capBreaches,
  };

  // Deterministic asserts.
  const violations = evaluateAsserts(scenario.asserts, summary);

  // SUT-health gate: when the SUT produced no usable output (a turn
  // errored, or every turn came back empty), the judge would only
  // describe the broken environment — confident axis failures that
  // aren't operator findings. Skip it, emit one clean meta finding,
  // and save the judge LLM cost.
  const inconclusive = inconclusiveReason(turns, finishReason);
  let judge: JudgeResult;
  if (inconclusive) {
    judge = buildInconclusiveJudge(scenario.rubric, inconclusive);
  } else {
    const personaSummary = describePersona(persona);
    const goalSummary = describeGoal(scenario.goal);
    judge = await judgeRun(
      {
        model: judgeModel,
        sutModel,
        rubric: scenario.rubric,
        scenarioId: scenario.id,
        scenarioDescription: scenario.description,
        personaSummary,
        goalSummary,
      },
      summary,
      violations,
      deps.llmCall,
    );
  }

  // Roll sim-user + judge cost into the summary so PG sees the
  // honest envelope, not just the SUT-side cost (which is currently
  // zero because operator-converse doesn't return per-stream cost).
  summary.totalCostUsd += simUser.costUsd + judge.costUsd;

  const hasErrorViolation = violations.some((v) => v.severity === 'error');
  const hasErrorFinding = judge.findings.some((f) => f.severity === 'error');
  let status: SingleRunReport['status'] = 'passed';
  // An inconclusive run is `errored`, not `failed` — the SUT/environment
  // broke, the operator did not behaviorally fail.
  if (finishReason === 'errored' || inconclusive) status = 'errored';
  else if (hasErrorViolation || hasErrorFinding) status = 'failed';

  if (claimKey && deps.claim) {
    try {
      await deps.claim.release(claimKey, claimOwner);
    } catch (err) {
      console.warn(`[llm-testing] claim release failed (${(err as Error).message}); claim will TTL out.`);
    }
  }

  return { summary, violations, judge, status };
}

/**
 * Returns a human-readable reason when a run is inconclusive — the SUT
 * never produced usable output — or null when the run is judgeable.
 *
 *  - finishReason 'errored': a turn ended in a transport/SUT error.
 *  - no turns at all: the loop never ran.
 *  - every turn empty: no assistant text AND no tool calls anywhere
 *    (tool calls count as output even when text is empty).
 */
export function inconclusiveReason(
  turns: TurnResult[],
  finishReason: RunSummary['finishReason'],
): string | null {
  if (finishReason === 'errored') {
    const errTurn = turns.find((t) => t.finishReason === 'error');
    return `SUT turn ended in error: ${errTurn?.error ?? 'unknown error'}`;
  }
  if (turns.length === 0) return 'no turns were produced';
  const allEmpty = turns.every(
    (t) => t.assistantText.trim() === '' && t.toolCalls.length === 0,
  );
  if (allEmpty) return `all ${turns.length} turn(s) produced empty output`;
  return null;
}

// =============================================================================
// Aggregation across a runMatrix
// =============================================================================

function aggregate(scenario: Scenario, matrixGroupId: string | undefined, runs: SingleRunReport[]): RunReport {
  if (!matrixGroupId || runs.length === 1) {
    const r = runs[0];
    // Plan §2.4: "Single-run results show as `preview` in the /tests UI,
    // not `pass`/`fail`. Only a matrix-completed run gets a `pass`/`fail`
    // verdict, computed from majority-of-N." Errors stay errored so they
    // remain visible; everything else is preview.
    const verdict: RunReport['verdict'] = !r
      ? 'errored'
      : r.status === 'errored' ? 'errored' : 'preview';
    return { scenarioId: scenario.id, matrixGroupId, runs, verdict, varianceByAxis: {}, varianceFindings: [] };
  }

  // Variance per axis.
  const varianceByAxis: Record<string, number> = {};
  const axes = scenario.rubric.axes;
  for (const axis of axes) {
    const vals = runs.map((r) => r.judge.scores[axis.id] ?? 0);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length;
    varianceByAxis[axis.id] = Math.sqrt(variance);
  }

  const varianceFindings: Violation[] = [];
  const policy = scenario.runMatrix?.variancePolicy ?? 'flag-if-stddev>0.5';
  if (policy === 'flag-if-stddev>0.5') {
    for (const [axis, stddev] of Object.entries(varianceByAxis)) {
      if (stddev > 0.5) {
        varianceFindings.push({
          assertKind: 'inconsistent_behavior',
          severity: 'warn',
          claim: `Score stddev ${stddev.toFixed(2)} on axis '${axis}' across ${runs.length} runs — operator behavior is inconsistent on this scenario.`,
          suggestion: 'Investigate the source of variance; non-determinism in operator behavior is itself a finding.',
        });
      }
    }
  } else if (policy === 'flag-if-disagreement') {
    const statuses = runs.map((r) => r.status);
    if (new Set(statuses).size > 1) {
      varianceFindings.push({
        assertKind: 'inconsistent_behavior',
        severity: 'warn',
        claim: `Status disagreement across ${runs.length} runs: ${statuses.join(', ')}`,
      });
    }
  }

  // Majority verdict.
  const counts = { passed: 0, failed: 0, errored: 0 };
  for (const r of runs) counts[r.status]++;
  let verdict: RunReport['verdict'] = 'fail';
  if (counts.errored > runs.length / 2) verdict = 'errored';
  else if (counts.passed > runs.length / 2) verdict = 'pass';
  else verdict = 'fail';

  return { scenarioId: scenario.id, matrixGroupId, runs, verdict, varianceByAxis, varianceFindings };
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Run a setup cleanup, swallowing (but logging) failures — a cleanup
 * error must never mask the run's own result/error.
 */
async function runSetupCleanup(
  cleanup: import('./deps').SetupCleanup | undefined,
  scenarioId: string,
): Promise<void> {
  if (!cleanup) return;
  try {
    await cleanup();
  } catch (err) {
    console.warn(
      `[llm-testing] setup cleanup failed for '${scenarioId}': ${(err as Error).message} — seeded state may linger.`,
    );
  }
}

function readScenarioHash(filePath: string | undefined): string {
  if (!filePath) return computeScenarioHash('no-file-provided');
  try {
    return computeScenarioHash(readFileSync(filePath, 'utf8'));
  } catch {
    return computeScenarioHash('file-read-failed');
  }
}

function endsWithQuestion(text: string): boolean {
  const trimmed = text.trimEnd();
  return trimmed.endsWith('?');
}

function describePersona(p: Persona): string {
  const t = p.traits;
  return `${p.id}: ${t.verbosity}, ${t.politeness}, ${t.clarification}, ${t.goalClarity}, modality=${t.modality}${t.interrupts ? ', interrupts' : ''}${t.domain ? `, domain=${t.domain}` : ''}`;
}

function describeGoal(g: Scenario['goal']): string {
  switch (g.kind) {
    case 'user_satisfied': return `User-driven satisfaction: the sim-user decides when the goal is reached.`;
    case 'tool_fired': return `Goal: SUT must invoke tool '${g.toolName}'.`;
    case 'card_emitted': return `Goal: SUT must emit a card of kind '${g.cardKind}'.`;
    case 'state_reached': return `Goal: ${g.predicate}`;
  }
}
