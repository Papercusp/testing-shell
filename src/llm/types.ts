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
   * Open a new session. Returns an opaque session that the runner threads
   * through `send()` / `close()`. Per-target implementations decide how
   * to allocate conversation ids, workspace roots, etc.
   */
  open(opts: SessionOptions): Promise<ChatSession>;
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
  mem0?: Array<{ kind: 'user' | 'project' | 'feedback' | 'reference'; body: string }>;
}

export interface ScenarioTrigger {
  /** When to fire (e.g. 'after 30s of awaiting_reply'). */
  on: 'silence' | 'after_turn' | 'at_secs';
  /** Trigger to inject. */
  fire: TurnTrigger;
  /** Parameter (e.g. 30 for 'silence'). */
  param?: number;
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
