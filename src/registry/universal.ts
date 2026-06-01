/**
 * universalDomains — testing domains that genuinely apply to ANY project,
 * not just Papercusp. Phase 1 of testing-shell-cross-project-2026-06-01
 * (decision D-007): the set was narrowed to the truly portable domains, and
 * each section names a logical `role` (no hardcoded glob) so a consumer
 * fills the globs for its own repo via {@link applyRoleGlobs}.
 *
 * Renamed from `generalizedRegistry`. The Papercusp-runtime-bound domains
 * that used to live here — test-runs (admin-suite orchestrator), live
 * (operator vitals), chaos (Tauri-shell clicker), ai (Stagehand walk over
 * the operator's admin routes) — moved into the operator's own
 * testing-domains-registry.ts, since they can't run against a non-Papercusp
 * project as-is (D-002 option b; generalizing chaos/ai/live to drive each
 * project's base URL is a deferred follow-up).
 *
 * PURE DATA — does NOT call defineTestDomain. The consumer registers these
 * (the operator barrel does
 * `applyRoleGlobs(universalDomains, …).forEach(defineTestDomain)`), keeping
 * this file side-effect-free so the lib stays `sideEffects: false`.
 */

import { type TestDomain } from '../registry';

export const universalDomains: TestDomain[] = [
  {
    id: 'routes',
    label: 'Routes',
    description: 'Endpoint test surface — the project’s HTTP/RPC route tests.',
    tier: 'universal',
    sections: [
      {
        id: 'endpoint-tests',
        label: 'Endpoint tests',
        // No baked glob — `role` is the project-resolvable handle. Each
        // consumer supplies its endpoint-test paths via applyRoleGlobs
        // (the operator maps 'endpoints' →
        // apps/operator/lib/endpoint-route/__tests__/**).
        role: 'endpoints',
      },
    ],
  },
];
