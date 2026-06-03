import { registerEvaluator } from './index';
import type { Violation } from '../types';

registerEvaluator('text_contains', (a, run) => {
  const turns = a.turnIdx !== undefined ? [run.turns[a.turnIdx]].filter(Boolean) : run.turns;
  const re = a.pattern instanceof RegExp ? a.pattern : new RegExp(escapeRegex(a.pattern), 'i');
  const hit = turns.some((t) => re.test(t.assistantText));
  if (!hit) {
    return [{
      assertKind: 'text_contains',
      severity: 'error',
      evidenceTurnIdx: a.turnIdx,
      claim: `Assistant text did not contain ${re}`,
    }];
  }
  return [];
});

registerEvaluator('text_excludes', (a, run) => {
  const turns = a.turnIdx !== undefined ? [run.turns[a.turnIdx]].filter(Boolean) : run.turns;
  const re = a.pattern instanceof RegExp ? a.pattern : new RegExp(escapeRegex(a.pattern), 'i');
  const v: Violation[] = [];
  for (let i = 0; i < turns.length; i++) {
    if (re.test(turns[i].assistantText)) {
      v.push({
        assertKind: 'text_excludes',
        severity: 'warn',
        evidenceTurnIdx: i,
        claim: `Assistant text contained banned pattern ${re}`,
      });
    }
  }
  return v;
});

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
