/**
 * Unit tests for derived rubric versions (WI-41678 / EI-21449130141174031).
 *
 * The property under test is narrow and load-bearing: editing an axis
 * description or a bad/ideal anchor MUST move the rubric's version, because
 * that version feeds `computeIdentityHash` and therefore decides which stored
 * runs are treated as comparable.
 *
 * Two deliberately-wrong implementations live in this file permanently, as
 * CONTROLS. A test that only asserts "the real one moves" cannot distinguish a
 * working derivation from a broken assertion — the controls prove the assertion
 * discriminates, by failing it in the two ways this mechanism is meant to
 * prevent. `HAND_MAINTAINED_LITERAL` reproduces the original defect exactly;
 * `deriveFromAxisIdsOnly` reproduces the subtler one, a hash that covers the
 * rubric's SHAPE but not the instructions the judge actually reads.
 */

import { describe, expect, it } from 'vitest';

import { deriveRubricVersion } from '../rubric-version';
import type { JudgeRubric } from '../types';

type RubricContent = Omit<JudgeRubric, 'version'>;

const BASE: RubricContent = {
  axes: [
    {
      id: 'groundedness',
      description: 'Did the answer stay grounded in the retrieved context?',
      anchors: {
        bad: 'Invents facts not present in the context.',
        ideal: 'Every claim traces to a retrieved passage.',
      },
    },
  ],
};

/** Same shape, ONLY the ideal anchor's wording changed. */
const ANCHOR_EDITED: RubricContent = {
  axes: [
    {
      id: 'groundedness',
      description: 'Did the answer stay grounded in the retrieved context?',
      anchors: {
        bad: 'Invents facts not present in the context.',
        ideal: 'Every claim cites the specific passage it came from.',
      },
    },
  ],
};

/** Same shape, ONLY the axis description's wording changed. */
const DESCRIPTION_EDITED: RubricContent = {
  axes: [
    {
      id: 'groundedness',
      description: 'Did the answer avoid asserting anything the context does not support?',
      anchors: {
        bad: 'Invents facts not present in the context.',
        ideal: 'Every claim traces to a retrieved passage.',
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// Controls — deliberately wrong, kept permanently.
// ---------------------------------------------------------------------------

/**
 * CONTROL 1 — the defect this work removes. A version nobody remembers to bump
 * stays put across any edit whatsoever.
 */
const HAND_MAINTAINED_LITERAL = (_label: string, _content: RubricContent): string => '1.0.0';

/**
 * CONTROL 2 — the near-miss. Hashing the rubric's structure (its axis ids)
 * catches an axis being added or removed, but NOT a rewritten anchor, which is
 * precisely the edit that changes what the judge is asked to do.
 */
const deriveFromAxisIdsOnly = (label: string, content: RubricContent): string =>
  `${label}.${content.axes.map((a) => a.id).join(',')}`;

describe('deriveRubricVersion', () => {
  it('produces `<label>.<sha12>`', () => {
    expect(deriveRubricVersion('queen', BASE)).toMatch(/^queen\.[0-9a-f]{12}$/);
  });

  it('is stable for unchanged content', () => {
    expect(deriveRubricVersion('queen', BASE)).toBe(deriveRubricVersion('queen', BASE));
  });

  it('distinguishes rubrics that share content but not identity', () => {
    expect(deriveRubricVersion('queen', BASE)).not.toBe(deriveRubricVersion('overwatch', BASE));
  });

  describe('an anchor or description edit moves the version', () => {
    // The calibration case: the REAL implementation must pass the property the
    // controls below are required to fail. Without this, both controls could be
    // "failing" because the property itself is unsatisfiable.
    it('real implementation: moves on an anchor-only edit', () => {
      expect(deriveRubricVersion('queen', ANCHOR_EDITED)).not.toBe(
        deriveRubricVersion('queen', BASE),
      );
    });

    it('real implementation: moves on a description-only edit', () => {
      expect(deriveRubricVersion('queen', DESCRIPTION_EDITED)).not.toBe(
        deriveRubricVersion('queen', BASE),
      );
    });

    it('CONTROL: a hand-maintained literal does NOT move — the original defect', () => {
      expect(HAND_MAINTAINED_LITERAL('queen', ANCHOR_EDITED)).toBe(
        HAND_MAINTAINED_LITERAL('queen', BASE),
      );
    });

    it('CONTROL: hashing only axis ids does NOT move on an anchor edit', () => {
      expect(deriveFromAxisIdsOnly('queen', ANCHOR_EDITED)).toBe(
        deriveFromAxisIdsOnly('queen', BASE),
      );
    });
  });

  describe('refuses inputs that would produce a plausible but wrong version', () => {
    it('rejects content carrying its own `version` (the circularity foot-gun)', () => {
      const composed: JudgeRubric = { version: 'queen.deadbeef0000', ...BASE };
      expect(() => deriveRubricVersion('queen', composed)).toThrow(/must not carry its own/i);
    });

    it('rejects a dotted label, which would make `<label>.<sha12>` ambiguous', () => {
      expect(() => deriveRubricVersion('queen.v1', BASE)).toThrow(/label must match/i);
    });

    it('rejects an empty label', () => {
      expect(() => deriveRubricVersion('', BASE)).toThrow(/label must match/i);
    });

    it('rejects non-object content', () => {
      expect(() => deriveRubricVersion('queen', 'axes')).toThrow(/non-null object/i);
      expect(() => deriveRubricVersion('queen', null)).toThrow(/non-null object/i);
      expect(() => deriveRubricVersion('queen', undefined)).toThrow(/non-null object/i);
    });
  });
});
