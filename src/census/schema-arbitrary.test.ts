/**
 * Tests for `schema-arbitrary` — Plan design-to-code-coverage-seam-2026-09-02 (P-023), D-042/D-043.
 *
 * THE CENTRAL PROPERTY, and why it is checked against a real validator rather than by eye:
 * this module's whole job is to emit values that CONFORM to a schema. Asserting the shape of a
 * generated value by hand only proves the assertion agrees with the generator — both can be
 * wrong together. So every generated value is validated with ajv (draft 2020-12, the dialect
 * zod 4's `toJSONSchema` emits), which is an independent implementation of the same spec.
 *
 * The fixtures are not invented. They are the real keyword shapes measured across all 885 live
 * mcp-tool `schema_ref` values in `harness_shared.testing_surfaces` (occurrence counts in D-043),
 * including the two that a guess would have got wrong: `not: {}` (42 occurrences — zod's
 * `z.never()`, which admits NO value) and `propertyNames` (124).
 */

import Ajv2020 from 'ajv/dist/2020';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  jsonSchemaToArbitrary,
  UnsatisfiableSchemaError,
  UnsupportedSchemaError,
  type JsonSchema,
} from './schema-arbitrary.js';

/** `strict:false` because zod emits annotations ajv's strict mode rejects; validation is unaffected. */
const ajv = new Ajv2020({ strict: false, allErrors: true });

/** Assert every value the arbitrary produces validates against the schema it came from. */
function expectConforms(schema: JsonSchema, runs = 100): void {
  const validate = ajv.compile(schema);
  const arb = jsonSchemaToArbitrary(schema);
  fc.assert(
    fc.property(arb, (value) => {
      if (validate(value)) return true;
      throw new Error(
        `generated value does not conform: ${JSON.stringify(value)} — ${ajv.errorsText(validate.errors)}`,
      );
    }),
    { numRuns: runs },
  );
}

describe('jsonSchemaToArbitrary — conformance against ajv', () => {
  // Each case is a keyword shape actually present in the live census corpus.
  const cases: Record<string, JsonSchema> = {
    'empty object (the minimal real row)': {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    'required + optional string': {
      type: 'object',
      properties: { slug: { type: 'string', minLength: 1 }, note: { type: 'string' } },
      required: ['slug'],
      additionalProperties: false,
    },
    'string bounds': { type: 'string', minLength: 3, maxLength: 12 },
    'enum': { enum: ['open', 'failing', 'done'] },
    'const': { const: 'mcp-tool' },
    'integer bounds': { type: 'integer', minimum: 1, maximum: 200 },
    'exclusiveMinimum': { type: 'integer', exclusiveMinimum: 0, maximum: 50 },
    'number': { type: 'number', minimum: 0, maximum: 1 },
    'boolean': { type: 'boolean' },
    'null': { type: 'null' },
    'array of strings with bounds': {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      minItems: 1,
      maxItems: 4,
    },
    'uniqueItems': { type: 'array', items: { type: 'integer', minimum: 0, maximum: 9 }, uniqueItems: true },
    'nested object': {
      type: 'object',
      properties: {
        inner: {
          type: 'object',
          properties: { id: { type: 'string' }, n: { type: 'integer', minimum: 0 } },
          required: ['id'],
          additionalProperties: false,
        },
      },
      required: ['inner'],
      additionalProperties: false,
    },
    'anyOf': { anyOf: [{ type: 'string', minLength: 1 }, { type: 'integer', minimum: 0 }] },
    'oneOf discriminated': {
      oneOf: [
        { type: 'object', properties: { kind: { const: 'a' }, a: { type: 'string' } }, required: ['kind', 'a'], additionalProperties: false },
        { type: 'object', properties: { kind: { const: 'b' }, b: { type: 'integer' } }, required: ['kind', 'b'], additionalProperties: false },
      ],
    },
    'type union array': { type: ['string', 'null'] },
    'propertyNames record': {
      type: 'object',
      properties: {},
      propertyNames: { type: 'string', minLength: 1 },
      additionalProperties: { type: 'string' },
    },
    '$ref into $defs': {
      $defs: { name: { type: 'string', minLength: 2, maxLength: 6 } },
      type: 'object',
      properties: { who: { $ref: '#/$defs/name' } },
      required: ['who'],
      additionalProperties: false,
    },
    'multipleOf': { type: 'integer', multipleOf: 5, minimum: 0, maximum: 100 },
    'format uuid': { type: 'string', format: 'uuid' },
    'format date-time': { type: 'string', format: 'date-time' },
    'format email': { type: 'string', format: 'email' },
    'optional never property is omitted': {
      type: 'object',
      properties: { ok: { type: 'string' }, impossible: { not: {} } },
      required: ['ok'],
      additionalProperties: false,
    },
  };

  for (const [name, schema] of Object.entries(cases)) {
    it(`generates conforming values for ${name}`, () => {
      expectConforms(schema);
    });
  }
});

describe('pattern', () => {
  // `pattern` is checked separately: ajv and JS share the regex engine, so this asserts the
  // generator honours it rather than asserting ajv agrees with itself.
  it('honours a pattern constraint', () => {
    const schema: JsonSchema = { type: 'string', pattern: '^P-\\d{3,}$' };
    const arb = jsonSchemaToArbitrary(schema);
    fc.assert(
      fc.property(arb, (v) => typeof v === 'string' && /^P-\d{3,}$/.test(v as string)),
      { numRuns: 50 },
    );
  });
});

describe('unsatisfiable schemas (zod z.never())', () => {
  it('treats `not: {}` as admitting no value', () => {
    expect(() => jsonSchemaToArbitrary({ not: {} })).toThrow(UnsatisfiableSchemaError);
  });

  it('propagates when a REQUIRED property is never', () => {
    expect(() =>
      jsonSchemaToArbitrary({
        type: 'object',
        properties: { impossible: { not: {} } },
        required: ['impossible'],
      }),
    ).toThrow(UnsatisfiableSchemaError);
  });

  it('omits an OPTIONAL never property instead of failing', () => {
    const arb = jsonSchemaToArbitrary({
      type: 'object',
      properties: { ok: { type: 'string' }, impossible: { not: {} } },
      required: ['ok'],
      additionalProperties: false,
    });
    fc.assert(
      fc.property(arb, (v) => {
        const obj = v as Record<string, unknown>;
        return 'ok' in obj && !('impossible' in obj);
      }),
      { numRuns: 30 },
    );
  });

  it('rejects a false schema', () => {
    expect(() => jsonSchemaToArbitrary(false as unknown as JsonSchema)).toThrow(UnsatisfiableSchemaError);
  });
});

describe('refusal beats silent omission', () => {
  // The point of the module: a constraint it cannot model must FAIL LOUDLY, because a generator
  // that silently drops one emits values the surface rejects and blames the code for it.
  it('refuses an unknown keyword', () => {
    expect(() => jsonSchemaToArbitrary({ type: 'string', shibboleth: 3 } as JsonSchema)).toThrow(
      UnsupportedSchemaError,
    );
  });

  it('refuses a non-empty `not`', () => {
    expect(() => jsonSchemaToArbitrary({ not: { type: 'string' } })).toThrow(UnsupportedSchemaError);
  });

  it('refuses an unknown string format', () => {
    expect(() => jsonSchemaToArbitrary({ type: 'string', format: 'ipv6' })).toThrow(
      UnsupportedSchemaError,
    );
  });

  it('refuses a remote $ref', () => {
    expect(() =>
      jsonSchemaToArbitrary({ $ref: 'https://example.com/schema.json' } as JsonSchema),
    ).toThrow(UnsupportedSchemaError);
  });

  it('refuses a recursive $ref rather than looping forever', () => {
    expect(() =>
      jsonSchemaToArbitrary({
        $defs: { node: { type: 'object', properties: { next: { $ref: '#/$defs/node' } } } },
        $ref: '#/$defs/node',
      }),
    ).toThrow(UnsupportedSchemaError);
  });

  it('refuses contradictory bounds as unsatisfiable', () => {
    expect(() => jsonSchemaToArbitrary({ type: 'integer', minimum: 10, maximum: 1 })).toThrow(
      UnsatisfiableSchemaError,
    );
  });
});

describe('negative control — the harness can actually fail', () => {
  // A conformance suite that cannot fail proves nothing. This asserts the instrument itself:
  // a deliberately WRONG generator must be caught by the same ajv check the real cases use.
  it('catches a generator that ignores a constraint', () => {
    const schema: JsonSchema = { type: 'string', minLength: 5 };
    const validate = ajv.compile(schema);
    const wrong = fc.constant(''); // violates minLength — what "silently ignoring" looks like
    expect(() =>
      fc.assert(
        fc.property(wrong, (v) => {
          if (validate(v)) return true;
          throw new Error('non-conforming');
        }),
        { numRuns: 5 },
      ),
    ).toThrow();
  });
});
