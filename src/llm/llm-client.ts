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
// Pricing — re-exported from the canonical table in @papercusp/model-pricing
// (cross-backend-cost-capture D-005: ONE price table; this module previously
// carried its own copy, which drifted — opus 4.x list price is $5/$25, not
// $15/$75). Vendor-prefixed ids ('openai-codex/gpt-5.5:xhigh') still resolve:
// the canonical `priceFor` normalizes them to bare ids.
// =============================================================================

export { MODEL_PRICES, estimateCost } from '@papercusp/model-pricing';
export type { ModelPrice } from '@papercusp/model-pricing';

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
