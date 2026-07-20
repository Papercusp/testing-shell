/**
 * Judge — the LLM that scores a completed transcript against a rubric.
 *
 * Plan §3.6, §6. Receives full transcript + per-turn telemetry +
 * deterministic-assert violations + the rubric, returns scores +
 * findings with copy-as-agent-prompt strings.
 *
 * Score-5 anchor (§6.5) prevents the judge from inventing novel
 * failures when the run looks fine.
 *
 * Decoupled: the concrete LLM transport is injected as the `llmCall`
 * parameter (an `LlmCallFn`) rather than imported, so this module names
 * no host backend.
 */

import { computeFindingShape } from './identity';
import type { LlmCallFn } from './deps';
import type {
  CardEvent,
  JudgeFinding,
  JudgeResult,
  JudgeRubric,
  RunSummary,
  TurnResult,
  Violation,
} from './types';

export interface JudgeOpts {
  model: string;
  rubric: JudgeRubric;
  scenarioId: string;
  scenarioDescription: string;
  personaSummary: string;
  goalSummary: string;
  temperature?: number;
  /**
   * SUT model — used by judges/registry to resolve the second-opinion
   * model for criticality='high' rubrics. Optional; if absent the
   * second-opinion pass reuses opts.model (no real bias mitigation).
   */
  sutModel?: string;
  /**
   * EI-336: the target's real, canonical tool-name catalog (when it has a
   * fixed one — `ChatTarget.toolNames`). Grounds any "is this tool name
   * real?" claim the rubric's groundedness/toolSelection anchors invite —
   * without it the judge was asserting real tools (e.g. `locks:acquire`,
   * `coord:declare-intent`) were "fabricated" purely from its own
   * (incomplete) memory of the registry, flipping a run to `failed` even
   * when every deterministic assert passed. Optional; omitted for targets
   * with no fixed catalog (the judge falls back to hedged judgment).
   */
  knownToolNames?: readonly string[];
}

export async function judgeRun(
  opts: JudgeOpts,
  run: RunSummary,
  violations: Violation[],
  llmCall: LlmCallFn,
): Promise<JudgeResult> {
  const transcript = formatTranscript(run.turns);
  const telemetryStrip = formatTelemetry(run);
  const violationsBlock = formatViolations(violations);

  const system = buildJudgeSystemPrompt(opts);
  const userPrompt = buildJudgeUserPrompt({
    transcript,
    telemetryStrip,
    violationsBlock,
    rubric: opts.rubric,
  });

  const passes: Array<{ scores: Record<string, number>; findings: JudgeFinding[]; notes?: string; rawText: string; agreesWithDeterministicAsserts?: boolean }> = [];
  let costUsd = 0;
  // Per plan §6.4 + §13 Q2: criticality='high' rubrics get TWO passes —
  // pass 0 uses opts.model (default judge), pass 1 uses the
  // second-opinion model (resolveJudgeModel(sutModel).secondOpinion).
  // The second pass at a different model is the bias-mitigation the
  // plan called for; same-model temperature-bump alone doesn't catch
  // self-grading.
  const isHigh = opts.rubric.criticality === 'high';
  const passModels: string[] = [opts.model];
  if (isHigh) {
    const { resolveJudgeModel } = await import('./judges/registry');
    const second = resolveJudgeModel(opts.sutModel ?? opts.model).secondOpinion ?? opts.model;
    passModels.push(second);
  }

  for (let i = 0; i < passModels.length; i++) {
    const passTemp = i === 0 ? (opts.temperature ?? 0) : 0.4;
    let result = await llmCall({
      model: passModels[i],
      system,
      messages: [{ role: 'user', content: userPrompt }],
      maxTokens: 4096,
      temperature: passTemp,
      responseFormat: 'json',
    });
    costUsd += result.costUsd;
    // One repair retry when the judge wraps its JSON in prose or fences
    // that even the brace-span extractor can't recover. Mirrors the
    // sim-user's strict-JSON retry — cheaper than a wasted judge pass.
    if (!result.json || typeof result.json !== 'object') {
      const retry = await llmCall({
        model: passModels[i],
        system,
        messages: [
          { role: 'user', content: userPrompt },
          { role: 'assistant', content: result.text },
          {
            role: 'user',
            content:
              'Your previous response could not be parsed as JSON. Return ONLY the JSON object — no prose, no markdown fences, no commentary before or after.',
          },
        ],
        maxTokens: 4096,
        temperature: passTemp,
        responseFormat: 'json',
      });
      costUsd += retry.costUsd;
      if (retry.json && typeof retry.json === 'object') result = retry;
    }
    const parsed = parseJudgeResponse(result.json, opts.rubric, opts.scenarioId);
    passes.push({ ...parsed, rawText: result.text });
  }

  // Merge passes: average scores, union findings (judge sees its own first pass
  // on the second attempt so duplicates are rare; still dedupe by shape).
  const mergedScores: Record<string, number> = {};
  for (const axis of opts.rubric.axes) {
    const vals = passes.map((p) => p.scores[axis.id] ?? 0);
    mergedScores[axis.id] = vals.reduce((a, b) => a + b, 0) / vals.length;
  }
  // Plan §6.4: 'flag axes where the two passes disagree by >1 point'.
  // Multi-pass at different models/temperatures gives us
  // disagreement signal — surface it as a meta finding so the run
  // doesn't silently average away a real cross-judge dispute.
  const interPassFindings: JudgeFinding[] = [];
  if (passes.length >= 2) {
    for (const axis of opts.rubric.axes) {
      const vals = passes.map((p) => p.scores[axis.id] ?? 0);
      const spread = Math.max(...vals) - Math.min(...vals);
      if (spread > 1) {
        interPassFindings.push({
          axis: 'meta',
          severity: 'warn',
          shape: computeFindingShape('meta', `judge_pass_disagreement:${axis.id}`),
          claim: `Multi-pass judge scored axis '${axis.id}' as ${vals.map((v) => v.toFixed(1)).join(' vs ')} — spread ${spread.toFixed(1)} > 1.0, treat the merged score with suspicion.`,
          suggestion: 'Re-run with a third judge pass or escalate the rubric anchor for this axis.',
          copyPrompt: '(judge inter-pass disagreement)',
          isNovel: false,
        });
      }
    }
  }
  const seenShapes = new Set<string>();
  const findings: JudgeFinding[] = [...interPassFindings];
  for (const f of interPassFindings) seenShapes.add(f.shape);
  for (const p of passes) {
    for (const f of p.findings) {
      if (seenShapes.has(f.shape)) continue;
      seenShapes.add(f.shape);
      findings.push(f);
    }
  }
  // Judge overruling: plan §3.6 says the judge returns
  // `agrees_with_deterministic_asserts: bool`. We parse that structured
  // field directly; fall back to substring-matching the claim text only
  // when the judge omits the field (older responses, parse failures).
  const agreesValues = passes
    .map((p) => p.agreesWithDeterministicAsserts)
    .filter((v): v is boolean => typeof v === 'boolean');
  let overruled: boolean;
  if (agreesValues.length > 0) {
    // If ANY pass said it disagrees, we surface that — the
    // single-dissenter signal matters in multi-pass mode.
    overruled = agreesValues.some((agrees) => !agrees);
  } else {
    overruled = findings.some((f) =>
      f.claim.toLowerCase().includes('disagree with deterministic'),
    );
  }

  return {
    scores: mergedScores,
    findings,
    notes: passes.map((p) => p.notes).filter(Boolean).join(' / ') || undefined,
    judgeOverruledAssert: overruled,
    costUsd,
  };
}

/**
 * Synthetic judge result for a run the SUT could not service — empty
 * output, all-error turns, or a transport failure. Running the real
 * judge on such a run produces confident-sounding axis failures
 * ("helpfulness: 0, the user received nothing") that describe the
 * broken environment, not the operator's behavior. The runner calls
 * this instead of `judgeRun` for inconclusive runs: one clean meta
 * finding, no wasted judge LLM cost.
 */
export function buildInconclusiveJudge(rubric: JudgeRubric, reason: string): JudgeResult {
  const scores: Record<string, number> = {};
  for (const axis of rubric.axes) scores[axis.id] = 0;
  return {
    scores,
    findings: [
      {
        axis: 'meta',
        severity: 'error',
        shape: computeFindingShape('meta', 'sut_no_output'),
        claim:
          `Run is inconclusive — the system under test produced no usable output (${reason}). ` +
          `This is an environment/SUT-health failure, not an operator behavioral finding.`,
        suggestion:
          'Verify the SUT endpoint is healthy and re-run. Do not file this as an operator bug.',
        copyPrompt: '(inconclusive run — no copy prompt)',
        isNovel: false,
      },
    ],
    judgeOverruledAssert: false,
    costUsd: 0,
  };
}

// =============================================================================
// Prompt construction
// =============================================================================

function buildJudgeSystemPrompt(opts: JudgeOpts): string {
  return [
    `You are evaluating a transcript from the **${opts.scenarioId}** test scenario.`,
    'You are not the assistant; you are an external reviewer scoring its behavior.',
    '',
    '## Scenario',
    opts.scenarioDescription,
    '',
    '## Persona driving the user',
    opts.personaSummary,
    '',
    '## Goal',
    opts.goalSummary,
    '',
    '## Rubric',
    'Score each axis 0..5 using the anchors below.',
    ...opts.rubric.axes.map(
      (a) =>
        `- **${a.id}** — ${a.description}\n    0 = ${a.anchors.bad}\n    5 = ${a.anchors.ideal}`,
    ),
    '',
    ...(opts.knownToolNames?.length
      ? [
          '## Known tool registry (ground truth — EI-336)',
          'This is the REAL, complete set of tool names available to the assistant this run. ' +
            'Any tool name the transcript uses that appears here IS REAL — never call it ' +
            '"fabricated", "invented", or "does not exist in any registry", regardless of ' +
            "whether you personally recognize it. Only a name ABSENT from this list may be " +
            'flagged as a possible fabrication, and even then hedge (you cannot see the full ' +
            'live registry, only this run\'s offered subset).',
          opts.knownToolNames.map((n) => `\`${n}\``).join(', '),
          '',
        ]
      : []),
    '## Rules',
    '- Cite turn indices (0-based) for every finding.',
    '- If you agree with a deterministic-assert violation, restate it with a turn-cite.',
    '- If you DISAGREE with one, set `agrees_with_deterministic_asserts: false` and explain.',
    "- `novel_failures` are behavioral problems NOT covered by the deterministic violations.",
    "- **Score-5 anchor**: if every axis would score ≥4 and you have no specific turn to cite, return `novel_failures: []` and `notes: \"nominal\"`. Do not invent critique to feel useful.",
    "- `suggestion` on each finding must be a concrete behavioral change (e.g. \"shorten the assistant turn at idx 2 to a single question\"), NOT an implementation change (\"rewrite handleConverse to...\").",
    '- Do not propose code changes. The framework will not auto-implement.',
    ...(opts.knownToolNames?.length
      ? []
      : [
          '- You have NO ground-truth tool registry for this run. Never assert a tool name is ' +
            '"fabricated" / "does not exist" with confidence — at most note it as unfamiliar ' +
            'and set a lower severity (`warn`, not `error`).',
        ]),
    '',
    '## Output schema',
    'Return ONLY a JSON object with this exact shape (no prose, no fences):',
    '```',
    '{',
    '  "summary": "one-paragraph headline",',
    '  "scores": { "<axis>": 0..5, ... },',
    '  "findings": [',
    '    {',
    '      "axis": "string",',
    '      "severity": "error" | "warn" | "info",',
    '      "evidence_turn_idx": 3,',
    '      "claim": "string",',
    '      "suggestion": "string"',
    '    }',
    '  ],',
    '  "agrees_with_deterministic_asserts": true,',
    '  "novel_failures": [',
    '    { "axis": "...", "severity": "...", "evidence_turn_idx": ..., "claim": "...", "suggestion": "..." }',
    '  ],',
    '  "notes": "string (optional)"',
    '}',
    '```',
  ].join('\n');
}

function buildJudgeUserPrompt(opts: {
  transcript: string;
  telemetryStrip: string;
  violationsBlock: string;
  rubric: JudgeRubric;
}): string {
  return [
    '## Transcript',
    opts.transcript,
    '',
    '## Per-turn telemetry',
    opts.telemetryStrip,
    '',
    '## Deterministic-assert violations',
    opts.violationsBlock,
    '',
    'Score the transcript per the rubric and return the JSON object.',
  ].join('\n');
}

function formatTranscript(turns: TurnResult[]): string {
  if (turns.length === 0) return '(empty transcript)';
  const lines: string[] = [];
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    lines.push(`### Turn ${i}`);
    lines.push(`**Assistant text:** ${t.assistantText.trim() || '(empty)'}`);
    if (t.toolCalls.length > 0) {
      lines.push(`**Tool calls:** ${t.toolCalls.map((tc) => `${tc.name}(${truncJson(tc.input)})`).join(', ')}`);
    }
    if (t.cards.length > 0) {
      lines.push(`**Cards:** ${t.cards.map(formatCard).join(', ')}`);
    }
    if (t.controlTags.length > 0) {
      lines.push(`**Control tags:** ${t.controlTags.map((c) => `<${c.tag}/>`).join(' ')}`);
    }
    lines.push(`**finishReason:** ${t.finishReason}${t.error ? ` — ${t.error}` : ''}${t.recoveredFromDisconnectAfterCard ? ' (recovered: card observed before disconnect)' : ''}`);
    lines.push('');
  }
  return lines.join('\n');
}

function formatCard(c: CardEvent): string {
  const opts = c.options ? `[${c.options.map((o) => o.id).join('|')}]` : '';
  return `${c.kind}${opts}${c.voiceAnswerable ? '(voice)' : ''}`;
}

function formatTelemetry(run: RunSummary): string {
  const rows: string[] = [];
  for (let i = 0; i < run.turns.length; i++) {
    const t = run.turns[i];
    rows.push(`Turn ${i}: ${t.latencyMs}ms · $${t.costUsd.toFixed(4)} · ${t.toolCalls.length} tool(s)`);
  }
  rows.push(`Total: ${run.totalCostUsd.toFixed(4)} USD`);
  if (run.continueChainRows.length > 0) {
    rows.push(`Continue chains: ${run.continueChainRows.length} row(s)`);
  }
  return rows.join('\n');
}

function formatViolations(violations: Violation[]): string {
  if (violations.length === 0) return '(none — all deterministic asserts passed)';
  return violations
    .map(
      (v, i) =>
        `${i}. [${v.severity}] ${v.assertKind}${v.evidenceTurnIdx !== undefined ? ` @ turn ${v.evidenceTurnIdx}` : ''}: ${v.claim}`,
    )
    .join('\n');
}

function truncJson(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s.length > 120 ? s.slice(0, 117) + '...' : s;
  } catch {
    return String(v);
  }
}

// =============================================================================
// Judge response parsing
// =============================================================================

function parseJudgeResponse(
  raw: unknown,
  rubric: JudgeRubric,
  scenarioId: string,
): { scores: Record<string, number>; findings: JudgeFinding[]; notes?: string; agreesWithDeterministicAsserts?: boolean } {
  if (!raw || typeof raw !== 'object') {
    return {
      scores: defaultScores(rubric),
      findings: [
        {
          axis: 'meta',
          severity: 'error',
          shape: computeFindingShape('meta', 'judge_parse_failed'),
          claim: `Judge response was not valid JSON for scenario ${scenarioId}`,
          copyPrompt: '(judge parse failure — no copy prompt)',
          isNovel: true,
        },
      ],
    };
  }
  const obj = raw as Record<string, unknown>;
  const scoresRaw = obj.scores;
  const findingsRaw = Array.isArray(obj.findings) ? obj.findings : [];
  const novelRaw = Array.isArray(obj.novel_failures) ? obj.novel_failures : [];
  // Plan §3.6 listed both `summary` ("one-paragraph headline") and
  // `notes` as judge-output fields; the example response used `notes`
  // and the prompt mentions both. Accept either and prefer `summary`
  // when present.
  const summaryField = typeof obj.summary === 'string' ? obj.summary : undefined;
  const notesField = typeof obj.notes === 'string' ? obj.notes : undefined;
  const notes = summaryField ?? notesField;
  const agreesWithDeterministicAsserts = typeof obj.agrees_with_deterministic_asserts === 'boolean'
    ? (obj.agrees_with_deterministic_asserts as boolean)
    : undefined;

  const scores: Record<string, number> = defaultScores(rubric);
  const findings: JudgeFinding[] = [];
  const rubricAxisIds = new Set(rubric.axes.map((a) => a.id));
  const judgeAxisIds = scoresRaw && typeof scoresRaw === 'object'
    ? Object.keys(scoresRaw as Record<string, unknown>)
    : [];

  if (scoresRaw && typeof scoresRaw === 'object') {
    for (const axis of rubric.axes) {
      const v = (scoresRaw as Record<string, unknown>)[axis.id];
      if (typeof v === 'number') {
        scores[axis.id] = Math.max(0, Math.min(5, v));
      } else {
        // Strict mode: missing rubric axis is a judge-protocol failure,
        // not silently 0. Flag it as a meta finding so we don't
        // mistake an absent score for a low score.
        findings.push({
          axis: 'meta',
          severity: 'warn',
          shape: computeFindingShape('meta', `judge_missing_axis:${axis.id}`),
          claim: `Judge omitted score for axis '${axis.id}' — defaulting to 0, but treat with suspicion.`,
          copyPrompt: '(judge protocol gap)',
          isNovel: false,
        });
      }
    }
  }
  for (const extra of judgeAxisIds.filter((id) => !rubricAxisIds.has(id))) {
    findings.push({
      axis: 'meta',
      severity: 'info',
      shape: computeFindingShape('meta', `judge_extraneous_axis:${extra}`),
      claim: `Judge emitted score for axis '${extra}' which is not in the rubric — ignored.`,
      copyPrompt: '(judge protocol noise)',
      isNovel: false,
    });
  }

  for (const f of findingsRaw) {
    const parsed = parseFinding(f, scenarioId, false);
    if (parsed) findings.push(parsed);
  }
  for (const f of novelRaw) {
    const parsed = parseFinding(f, scenarioId, true);
    if (parsed) findings.push(parsed);
  }

  return { scores, findings, notes, agreesWithDeterministicAsserts };
}

function parseFinding(raw: unknown, scenarioId: string, isNovel: boolean): JudgeFinding | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const axis = typeof obj.axis === 'string' ? obj.axis : 'unknown';
  const severityVal = obj.severity;
  const severity: 'error' | 'warn' | 'info' =
    severityVal === 'error' || severityVal === 'warn' || severityVal === 'info' ? severityVal : 'warn';
  const claim = typeof obj.claim === 'string' ? obj.claim : '';
  if (!claim) return null;
  const suggestion = typeof obj.suggestion === 'string' ? obj.suggestion : undefined;
  const idxRaw = obj.evidence_turn_idx;
  const evidenceTurnIdx = typeof idxRaw === 'number' ? idxRaw : undefined;
  const shape = computeFindingShape(axis, claim);
  return {
    axis,
    severity,
    shape,
    evidenceTurnIdx,
    claim,
    suggestion,
    copyPrompt: formatCopyPrompt({ scenarioId, axis, severity, evidenceTurnIdx, claim, suggestion }),
    isNovel,
  };
}

function defaultScores(rubric: JudgeRubric): Record<string, number> {
  const o: Record<string, number> = {};
  for (const a of rubric.axes) o[a.id] = 0;
  return o;
}

function formatCopyPrompt(input: {
  scenarioId: string;
  axis: string;
  severity: string;
  evidenceTurnIdx?: number;
  claim: string;
  suggestion?: string;
}): string {
  return [
    `The operator chat in scenario \`${input.scenarioId}\` exhibits the following issue:`,
    '',
    `**Finding:** ${input.claim}`,
    `**Axis:** ${input.axis}`,
    `**Severity:** ${input.severity}`,
    input.evidenceTurnIdx !== undefined ? `**Evidence:** turn ${input.evidenceTurnIdx}` : '',
    input.suggestion ? `**Suggestion:** ${input.suggestion}` : '',
    '',
    'Please investigate. Run the scenario locally with:',
    '```',
    `pnpm llm-test --scenario ${input.scenarioId}`,
    '```',
  ]
    .filter(Boolean)
    .join('\n');
}
