/**
 * Generic LLM-client helpers for the sim-user + judge.
 *
 * The concrete LLM transport (`llmCall`) is NOT defined here — it is an
 * injected seam (`LlmCallFn` in ./deps), because the real implementation is
 * host-specific (the operator routes through its `runAgentChat` + credentials).
 * This module holds only the host-agnostic pieces every consumer needs:
 * pricing, cost estimation, JSON recovery, and the call opts/result shapes.
 *
 * The operator's concrete `llmCall` (which imports its agent-chat-stream +
 * credentials) and `isLlmAvailable` (which reads operator credentials) stay
 * operator-side and are injected into the runner via `RunnerDeps.llmCall`.
 */

// =============================================================================
// Pricing (USD per 1M tokens) — kept exported for callers that estimate
// cost ahead of a call. A host's concrete `llmCall` backend should compute
// per-call cost from this same table; keep them in sync.
// =============================================================================

interface ModelPrice { in: number; out: number }
export const MODEL_PRICES: Record<string, ModelPrice> = {
  'claude-haiku-4-5':  { in: 0.80, out: 4.00 },
  'claude-sonnet-4-6': { in: 3.00, out: 15.00 },
  'claude-opus-4-7':   { in: 15.00, out: 75.00 },
  'claude-opus-4-8':   { in: 15.00, out: 75.00 },
  'openai-codex/gpt-5':         { in: 1.25, out: 10.00 },
  'openai-codex/gpt-5.5':       { in: 2.50, out: 20.00 },
  'openai-codex/gpt-5.5:xhigh': { in: 2.50, out: 20.00 },
  // OpenAI direct models — used by hosts whose SUT/judge/sim run on OpenAI
  // (e.g. Restart's Scout SUT is gpt-4o-mini). Per 1M tokens, USD.
  'gpt-4o-mini':                { in: 0.15, out: 0.60 },
  'gpt-4o':                     { in: 2.50, out: 10.00 },
};

function priceFor(model: string): ModelPrice {
  if (MODEL_PRICES[model]) return MODEL_PRICES[model];
  const prefix = Object.keys(MODEL_PRICES).find((m) => model.startsWith(m));
  return prefix ? MODEL_PRICES[prefix] : { in: 0, out: 0 };
}

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const p = priceFor(model);
  return (inputTokens * p.in + outputTokens * p.out) / 1_000_000;
}

// =============================================================================
// One-shot completion shapes. The concrete implementation is injected via
// `LlmCallFn` (see ./deps) — a host wires its own transport.
// =============================================================================

export interface LlmCallOpts {
  model: string;
  system?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  maxTokens?: number;
  temperature?: number;
  responseFormat?: 'text' | 'json';
  /**
   * Extended-thinking budget (tokens). A host backend may thread this to the
   * provider's thinking budget. Needed by a frozen Opus judge ("extra-high
   * thinking"). Note: thinking and `temperature` are typically mutually
   * exclusive on the provider API; the host backend decides how to reconcile.
   */
  thinkingBudgetTokens?: number;
}

export interface LlmCallResult {
  text: string;
  json?: unknown;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  raw: unknown;
}

export function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  // 1. Bare JSON, or JSON wrapped in ```json fences.
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const candidate = fenced ? fenced[1] : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    // fall through
  }
  // 2. Prose-wrapped JSON: take the outermost {...} span.
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(trimmed.slice(first, last + 1));
    } catch {
      /* unrecoverable */
    }
  }
  return null;
}

/**
 * Legacy helper retained for any host caller that detects a model newly
 * rejecting the `temperature` parameter. Pure regex over the error message —
 * no host coupling.
 */
export function isTemperatureDeprecatedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /temperature.{0,40}(deprecat|not supported|unsupported|no longer)/i.test(msg);
}
