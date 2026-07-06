/**
 * LLM testing framework — core types.
 *
 * Plan: apps/operator/docs/plans/llm-testing-framework-2026-05-14.md (v2)
 *
 * Three roles:
 *   - SimUser (LLM)  drives the conversation as a realistic user persona
 *   - SUT (LLM)      the system under test (operator, architect, ...)
 *   - Judge (LLM)    scores the resulting transcript against a rubric
 *
 * Generic-from-day-1: a ChatTarget abstracts away the transport so a
 * single Runner / Judge / Persona / Assert layer drives any LLM chat
 * surface. First implementation = operator; future ones in §11.
 */

// =============================================================================
// ChatTarget — what a target chat surface looks like to the runner
// =============================================================================

export interface ChatTarget {
  /** Stable id, e.g. 'operator', 'architect', 'brain-debug'. */
  readonly id: string;

  /** Behavior catalog id list (§10.1) — useful for coverage reports. */
  readonly behaviors: string[];

  /**
   * Variant-knob support (test-gym-apiary-framework-2026-06-09 P-001/D-001).
   * A target that knows how to APPLY a {@link ScenarioVariant} (overlay the
   * SUT prompt / apply the config delta) declares `true`. The runner REFUSES
   * to run a variant against a target that doesn't — silently ignoring the
   * variant would make an eval compare baseline vs baseline and report a
   * fake "no difference".
   */
  readonly supportsVariants?: boolean;

  /**
   * Open a new session. Returns an opaque session that the runner threads
   * through `send()` / `close()`. Per-target implementations decide how
   * to allocate conversation ids, workspace roots, etc.
   */
  open(opts: SessionOptions): Promise<ChatSession>;
}

/**
 * The eval variant knob (test-gym-apiary-framework-2026-06-09 P-001).
 *
 * An eval = a registered scenario + a variant injected AT RUNTIME — a
 * parameterized scenario, not a committed file per idea. The variant is the
 * "candidate" a compare/select runner (P-002) runs against the baseline
 * (no variant). Two delta shapes, both optional, composable:
 *
 *   - `promptOverlay` — text appended to the SUT's system prompt (e.g. a
 *     Scout-proposed playbook/persona amendment under evaluation).
 *   - `configDelta`  — target-interpreted config knobs (e.g. a different
 *     SUT model, a blueprint knob). Each target documents the keys it
 *     understands and MUST reject unknown keys loudly — a silently-dropped
 *     knob is a baseline run mislabeled as the candidate.
 */
export interface ScenarioVariant {
  /** Stable id stamped on the run ('baseline' is reserved for no-variant). */
  id: string;
  /** Appended to the SUT system prompt (after the target's base prompt). */
  promptOverlay?: string;
  /** Target-interpreted config knobs; unknown keys must fail the run. */
  configDelta?: Record<string, unknown>;
}

export interface SessionOptions {
  /** Unique per-run identity used as `uiClientId` for telemetry filtering. */
  runId: string;
  /** Workspace mode — see §4.5. */
  workspaceMode: 'isolated' | 'real';
  /** Transport — see §10.4. */
  transport: 'in-process' | 'http-sse';
  /** Optional dispatcher override — see §10.4. */
  dispatchOverride?: ToolDispatchOverride;
  /**
   * Eval variant to apply to this session (P-001). Only delivered to targets
   * declaring `supportsVariants` — the runner gates it.
   */
  variant?: ScenarioVariant;
}

export interface ChatSession {
  /** Session identity (e.g. operator conversationId). */
  readonly sessionId: string;
  /** Send one turn into the SUT and collect the resulting events. */
  send(input: TurnInput): Promise<TurnResult>;
  /** Tear down. Frees per-run resources (isolated workspace PG, etc.). */
  close(): Promise<void>;
}

export interface TurnInput {
  /** Conversation transcript so far, in the SUT's wire format. */
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  /** What kind of turn this is. */
  trigger: TurnTrigger;
  /** Per-trigger payload (e.g. welcomed_user, modality). */
  meta?: Record<string, unknown>;
}

export type TurnTrigger =
  | 'user_message'
  | 'continue'
  | 'quiet_wait_resume'
  | 'user_says_ready'
  | 'user_welcomed'
  | 'open_canvas'
  | 'silence_nudge'
  | 'generate_ideas';

export interface TurnResult {
  /** Accumulated `delta` text. */
  assistantText: string;
  /** Tool calls the SUT emitted during this turn. */
  toolCalls: ToolCallEvent[];
  /** Cards (ctx.askUser / ctx.publishState envelopes). */
  cards: CardEvent[];
  /** Control tags (<continue/>, <sleep/>, <spawn/>, etc.). */
  controlTags: ControlTag[];
  /** Sum of model cost for this turn, USD. */
  costUsd: number;
  /** Wall-clock latency from request to `done`/`error`. */
  latencyMs: number;
  /** How the turn ended. */
  finishReason: 'done' | 'error' | 'aborted' | 'budget' | 'cap';
  error?: string;
  /** Full SSE event tape for replay/judge. */
  rawSseTape: SseEvent[];
}

export interface ToolCallEvent {
  name: string;
  input: unknown;
  /** True if the dispatcher override fielded this call. */
  overridden?: boolean;
}

export interface CardEvent {
  kind: string;
  /** Choice options if presentation is radio/select. */
  options?: Array<{ id: string; label: string }>;
  /** Whether the card carries fallbackText for voice rendering. */
  voiceAnswerable?: boolean;
  /** Free-form payload from ctx.askUser/publishState. */
  payload?: unknown;
}

export interface ControlTag {
  tag: 'continue' | 'sleep' | 'spawn' | 'set_mode';
  /**
   * Attributes / payload depending on tag kind. For `set_mode`, the
   * paired-tag inner text (passive|active) lands as `attrs.value`.
   */
  attrs?: Record<string, string>;
}

export interface SseEvent {
  /** SSE event name (`delta`, `tool_call`, `done`, `error`, `card`, `state`, ...). */
  name: string;
  /** Raw payload. */
  data: unknown;
  /** Monotonic ms offset from session start, for timing-sensitive scenarios. */
  tMs: number;
}

// =============================================================================
// ToolDispatchOverride — §10.4
// =============================================================================

/** Sentinel: "I don't have an override for this; fall through to the real dispatcher." */
export const PASS_THROUGH = Symbol('PASS_THROUGH');

export interface ToolResult {
  /** Match the dispatcher's normal result envelope. */
  content: Array<{ text?: string; [k: string]: unknown }>;
  /** Optional error result; the SUT brain sees this and recovers (B21). */
  isError?: boolean;
}

export interface ToolDispatchOverride {
  /**
   * Decide what to do with a tool call. Return PASS_THROUGH to let the
   * real dispatcher handle it; return a ToolResult (or a Promise of one)
   * to override.
   */
  override(name: string, args: unknown): Promise<ToolResult | typeof PASS_THROUGH> | ToolResult | typeof PASS_THROUGH;
}

// =============================================================================
// Persona — composable traits + named blends (§3.2)
// =============================================================================

export interface PersonaTraits {
  verbosity: 'terse' | 'normal' | 'verbose';
  politeness: 'rude' | 'neutral' | 'polite';
  clarification: 'never_clarifies' | 'sometimes' | 'always';
  goalClarity: 'precise' | 'vague' | 'shifting';
  interrupts: boolean;
  modality: 'text' | 'voice';
  domain?: 'admin' | 'dev' | 'pm' | 'support';
}

export interface Persona {
  id: string;
  description: string;
  traits: PersonaTraits;
}

// =============================================================================
// Scenario — the contract (§3.3)
// =============================================================================

export interface Scenario {
  id: string;
  version: number;
  target: string;
  description: string;
  persona: Persona | PersonaTraits | string; // blend name | inline traits | Persona
  goal: GoalSpec;
  setup?: ScenarioSetup;
  triggers?: ScenarioTrigger[];
  asserts: DeterministicAssert[];
  rubric: JudgeRubric;
  caps: { maxTurns: number; maxWallSecs: number; maxCostUsd: number };

  // Round-2 additions
  runMatrix?: {
    repeat: number;
    variancePolicy?: 'flag-if-stddev>0.5' | 'flag-if-disagreement' | 'none';
  };
  realWorkspace?: boolean;
  transport?: 'in-process' | 'http-sse';
  toolOverride?: ToolDispatchOverride;
  fixtures?: { sseTapePath?: string };
  /**
   * Compaction seam (P-006) — when set, the runner rewrites the wire history
   * before {@link CompactionPolicy.beforeTurn} to simulate a compacted-away
   * base snapshot. Omit for the normal full-history thread.
   */
  compactionPolicy?: CompactionPolicy;
}

export type GoalSpec =
  | { kind: 'user_satisfied'; declaredBy: 'sim_user' }
  | { kind: 'tool_fired'; toolName: string }
  | { kind: 'card_emitted'; cardKind: string }
  | { kind: 'state_reached'; predicate: string };

export interface ScenarioSetup {
  /** Per-run seed data inserted before the conversation starts. */
  features?: unknown[];
  issues?: unknown[];
  /**
   * Memory entries seeded through the host's memory backend before the
   * session opens (and forgotten again after the run — the host's
   * `RunnerDeps.applySetup` returns the cleanup). `scope` names the pool
   * to seed in the host's own scope vocabulary (the operator uses
   * `harness:<slug>`; omitted → the host's default seeding pool). Kept
   * neutral here: the lib never interprets it.
   */
  mem0?: Array<{
    kind: 'user' | 'project' | 'feedback' | 'reference';
    body: string;
    scope?: string;
  }>;
}

export interface ScenarioTrigger {
  /** When to fire (e.g. 'after 30s of awaiting_reply'). */
  on: 'silence' | 'after_turn' | 'at_secs';
  /** Trigger to inject. */
  fire: TurnTrigger;
  /**
   * Optional deterministic user text for `fire: 'user_message'`. When present,
   * the runner appends this user turn instead of asking the sim-user. This keeps
   * multi-turn contract scenarios from depending on the sim-user to choose the
   * required follow-up prompt.
   */
  text?: string;
  /** Parameter (e.g. 30 for 'silence'). */
  param?: number;
}

/**
 * Compaction seam (agent-tool-delta-protocol-2026-06-22 P-006 / D-008).
 *
 * The runner normally threads the FULL verbatim wire history into every
 * `session.send` — there is no pruning, so "the base snapshot the model
 * fetched earlier got compacted away" is not simulable, and base-eviction
 * (the silent-wrong-merge hazard the delta protocol must retire) is
 * untestable. A scenario sets `compactionPolicy` to faithfully model it:
 * right before the designated turn the runner rewrites the wire history,
 * replacing the leading `[0, upTo)` messages with a SINGLE lossy summary
 * block. The rewrite is permanent (mirrors real compaction) — it persists
 * for every later turn. After it, the verbatim base rows are gone, so a
 * subsequent delta turn cannot be merged against an in-context base and the
 * correct SUT behavior is to re-fetch full.
 *
 * NOTE on `summaryRole`: some in-process targets (the `su` target) DROP
 * `role:'system'` messages from the wire history, so a `system` summary
 * would vanish entirely (still a faithful eviction, just with no summary
 * marker the model can see). Default `user` keeps the summary visible.
 */
export interface CompactionPolicy {
  /**
   * 0-indexed turn the compaction fires BEFORE (i.e. before that turn's
   * user message is appended). Use a value ≥ 1 — there is nothing to
   * compact before turn 0.
   */
  beforeTurn: number;
  /**
   * Replace wire messages `[0, upTo)` with the single summary block. Clamped
   * to the current history length; `0` is a no-op. Choose it to evict the
   * base-snapshot turn(s) while keeping any later exchange you want retained.
   */
  upTo: number;
  /**
   * The lossy summary text that replaces the dropped messages. Models a
   * compaction that has paraphrased away the verbatim snapshot. Defaults to
   * {@link DEFAULT_COMPACTION_SUMMARY}.
   */
  summary?: string;
  /**
   * Role for the inserted summary message. Defaults to `'user'` (a `system`
   * summary is dropped by targets that filter system turns — see the note
   * above; `assistant` would make the rewritten history start with an
   * assistant turn).
   */
  summaryRole?: 'user' | 'assistant' | 'system';
}

// =============================================================================
// Deterministic asserts (§5)
// =============================================================================

export type DeterministicAssert =
  | { kind: 'tool_called'; name: string; minTimes?: number; maxTimes?: number; withArgsMatching?: Record<string, unknown> }
  | { kind: 'tool_not_called'; name: string }
  | { kind: 'text_contains'; pattern: string | RegExp; turnIdx?: number }
  | { kind: 'text_excludes'; pattern: string | RegExp; turnIdx?: number }
  | { kind: 'card_emitted'; cardKind: string; optionsInclude?: string[]; voiceAnswerable?: boolean }
  | { kind: 'control_tag_present'; tag: 'continue' | 'sleep' | 'spawn'; minCount?: number; maxCount?: number }
  | { kind: 'auto_fire_happened'; trigger: 'continue' | 'user_says_ready' }
  | { kind: 'auto_fire_did_not_happen' }
  | { kind: 'continue_chain_within_cap'; maxTurns: number; maxSecs: number }
  | { kind: 'latency_under'; p50?: number; p95?: number }
  | { kind: 'cost_under'; usd: number }
  | { kind: 'mem0_wrote'; matching?: Partial<Record<'user' | 'project' | 'feedback' | 'reference', boolean>> }
  | { kind: 'mem0_read'; matching?: Record<string, unknown> }
  | { kind: 'spawn_dispatched'; role: string; feature?: string }
  | { kind: 'finish_reason_is'; expected: TurnResult['finishReason'] }
  | { kind: 'custom'; name: string; eval: (run: RunSummary) => Violation[] };

export interface Violation {
  assertKind: string;
  severity: 'error' | 'warn' | 'info';
  evidenceTurnIdx?: number;
  claim: string;
  suggestion?: string;
  /**
   * If this violation came from a promoted-from-finding assert, the
   * source finding ids that drove the promotion. storage.ts writes
   * them into llm_test_findings.promoted_from when persisting, so the
   * UI can show provenance ("this check originated from N judge
   * findings in older runs").
   */
  originatingFindingIds?: string[];
}

// =============================================================================
// Judge rubric (§6)
// =============================================================================

export interface JudgeRubric {
  version: string;
  axes: JudgeAxis[];
  /** 'high' invokes multi-pass judging at higher cost (§6.4). */
  criticality?: 'normal' | 'high';
}

export interface JudgeAxis {
  /** e.g. 'helpfulness', 'groundedness', 'terminationFit', 'speakability'. */
  id: string;
  description: string;
  /** Anchors for 0 (bad) and 5 (ideal). */
  anchors: { bad: string; ideal: string };
}

export interface JudgeResult {
  scores: Record<string, number>;          // axis → 0..5
  findings: JudgeFinding[];
  notes?: string;
  judgeOverruledAssert: boolean;
  /** Sum of judge LLM call costs across all passes. */
  costUsd: number;
}

export interface JudgeFinding {
  axis: string;
  severity: 'error' | 'warn' | 'info';
  shape: string;                            // sha256(axis + summary_normalized) for promotion grouping
  evidenceTurnIdx?: number;
  claim: string;
  suggestion?: string;
  copyPrompt: string;                       // pre-formatted "send to fixer agent"
  isNovel: boolean;                         // true if no deterministic assert covered this
}

// =============================================================================
// RunSummary — everything the runner/judge sees about a single run
// =============================================================================

export interface RunSummary {
  runId: string;
  scenarioId: string;
  scenarioVersion: number;
  identityHash: string;
  matrixGroupId?: string;
  matrixIndex?: number;
  sutModel: string;
  judgeModel: string;
  personaId: string;
  personaTraits: PersonaTraits;
  /** Eval variant this run executed under (P-001); absent = baseline. */
  variantId?: string;
  workspaceMode: 'isolated' | 'real';
  transportMode: 'in-process' | 'http-sse';
  turns: TurnResult[];
  toolInvocations: ToolInvocationRow[];     // pulled from PG
  continueChainRows: ContinueChainRow[];    // pulled from operator_continue_chains
  totalCostUsd: number;
  startedAt: Date;
  finishedAt: Date;
  finishReason: 'completed' | 'cap_breach' | 'errored' | 'aborted';
  capBreaches: string[];
}

export interface ToolInvocationRow {
  toolName: string;
  argsJson: unknown;
  resultJson: unknown;
  costUsd: number;
  latencyMs: number;
  metadataJson: Record<string, unknown>;
}

export interface ContinueChainRow {
  chainId: string;
  turnIdx: number;
  trigger: 'continue' | 'auto_fire_terminal' | 'reset';
  startedAt: Date;
  elapsedSecsInChain: number;
  wasCapped: boolean;
  capReason: string | null;
}
