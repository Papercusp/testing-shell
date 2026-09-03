/**
 * `schema-arbitrary` — derive a fast-check `Arbitrary` from a censused surface's JSON Schema.
 *
 * Plan: design-to-code-coverage-seam-2026-09-02 (P-023), Decisions D-042 and D-043.
 *
 * WHY THIS READS JSON SCHEMA AND NOT ZOD. P-023 originally said "a zod-4 adapter, deriving
 * arbitraries from the `testing_surfaces.schema_ref` zod schemas". There are no zod schemas to
 * derive from: `schema_ref` holds JSON Schema, because `defineTool` projects `def.args` through
 * zod 4's own `z.toJSONSchema` at definition time (`tooldef/src/schema-adapter.ts`) and the
 * projected registry keeps only `Record<string, unknown>`. The zod object is gone before the
 * census ever sees a surface. D-042 has the full measurement; the short version is that a zod
 * adapter has no zod to consume, and the three candidate packages are each unusable here
 * (`zod-fast-check` needs fast-check <4 and zod ^3; `@fast-check/zod` does not exist;
 * `json-schema-fast-check` is 2022-era on fast-check ^1). So: JSON Schema in, arbitrary out.
 *
 * WHY REFUSING BEATS IGNORING. Every unknown keyword is REJECTED (`UnsupportedSchemaError`)
 * rather than skipped. A generator that silently drops a constraint it does not understand
 * emits values the surface legitimately rejects, and the property test then reports a failure
 * that is the INSTRUMENT's fault, not the code's. On a plan whose subject is silent wrong
 * answers, a generator that quietly lies about what it covered is the worst possible tool. The
 * supported set below is not a guess: it is the measured vocabulary of all 885 live mcp-tool
 * `schema_ref` values (D-043 lists the occurrence counts).
 *
 * WHY UNSATISFIABLE IS A DISTINCT OUTCOME. zod's `z.never()` projects to `{"not":{}}`, which
 * appears 42 times in the live corpus. "No value can satisfy this" is NOT the same as "error",
 * and it is not something you can represent as an arbitrary — `fc.constant(undefined)` would be
 * a lie. It is raised as `UnsatisfiableSchemaError` so the object builder can do the only
 * correct thing: omit the key when it is optional, and propagate when it is required.
 */

import fc from 'fast-check';

/** A keyword this converter understands. Anything else is refused — see the module header. */
const SUPPORTED_KEYWORDS = new Set([
  // structural
  'type', 'properties', 'required', 'additionalProperties', 'propertyNames',
  'items', 'prefixItems', 'enum', 'const',
  // combinators
  'anyOf', 'oneOf', 'allOf', 'not', '$ref', '$defs',
  // scalar constraints
  'minLength', 'maxLength', 'pattern', 'format',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minItems', 'maxItems', 'uniqueItems',
  // annotations — carry no constraint, so ignoring them is sound rather than silent
  'description', 'title', 'default', 'examples', 'deprecated',
  'readOnly', 'writeOnly', '$comment', '$schema', '$id', 'additionalItems',
]);

/** String `format` values present in the live corpus, with a faithful generator for each. */
const FORMAT_ARBITRARIES: Record<string, () => fc.Arbitrary<string>> = {
  uuid: () => fc.uuid(),
  'date-time': () => fc.date({ noInvalidDate: true }).map((d) => d.toISOString()),
  uri: () => fc.webUrl(),
  url: () => fc.webUrl(),
  email: () => fc.emailAddress(),
};

/** Raised when the schema uses a keyword this converter does not model. */
export class UnsupportedSchemaError extends Error {
  constructor(readonly path: string, readonly detail: string) {
    super(`unsupported schema at ${path || '#'}: ${detail}`);
    this.name = 'UnsupportedSchemaError';
  }
}

/**
 * Raised when a schema admits NO value (zod `z.never()` → `{"not":{}}`).
 * Distinct from `UnsupportedSchemaError`: the schema is understood perfectly, and the correct
 * answer is that nothing satisfies it.
 */
export class UnsatisfiableSchemaError extends Error {
  constructor(readonly path: string) {
    super(`schema at ${path || '#'} admits no value (never)`);
    this.name = 'UnsatisfiableSchemaError';
  }
}

export interface SchemaArbitraryOptions {
  /**
   * Root schema used to resolve `$ref`. Defaults to the schema passed in, which is what you
   * want for a whole-surface schema whose `$defs` sit at its own root.
   */
  root?: JsonSchema;
  /** Cap on generated string/array size, so a fuzz run stays bounded. */
  maxSize?: number;
}

export type JsonSchema = Record<string, unknown>;

const DEFAULT_MAX_SIZE = 8;

function isPlainObject(v: unknown): v is JsonSchema {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Resolve a local `#/$defs/name` pointer. Remote refs are refused rather than fetched. */
function resolveRef(ref: string, root: JsonSchema, path: string): JsonSchema {
  if (!ref.startsWith('#/')) {
    throw new UnsupportedSchemaError(path, `only local #/ refs are supported, got ${ref}`);
  }
  let node: unknown = root;
  for (const rawSeg of ref.slice(2).split('/')) {
    const seg = rawSeg.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isPlainObject(node) || !(seg in node)) {
      throw new UnsupportedSchemaError(path, `unresolvable $ref ${ref}`);
    }
    node = (node as JsonSchema)[seg];
  }
  if (!isPlainObject(node)) throw new UnsupportedSchemaError(path, `$ref ${ref} is not a schema`);
  return node;
}

/**
 * Convert one JSON Schema into an arbitrary producing values that CONFORM to it.
 *
 * Throws `UnsupportedSchemaError` for anything it cannot model faithfully and
 * `UnsatisfiableSchemaError` for a schema no value satisfies.
 */
export function jsonSchemaToArbitrary(
  schema: JsonSchema,
  options: SchemaArbitraryOptions = {},
): fc.Arbitrary<unknown> {
  const root = options.root ?? schema;
  const maxSize = options.maxSize ?? DEFAULT_MAX_SIZE;
  return build(schema, { root, maxSize, path: '#', seen: new Set() });
}

interface Ctx {
  root: JsonSchema;
  maxSize: number;
  path: string;
  seen: Set<JsonSchema>;
}

function build(schema: unknown, ctx: Ctx): fc.Arbitrary<unknown> {
  // `true`/`false` are legal JSON Schema shorthand for "anything"/"nothing".
  if (schema === true) return fc.anything();
  if (schema === false) throw new UnsatisfiableSchemaError(ctx.path);
  if (!isPlainObject(schema)) {
    throw new UnsupportedSchemaError(ctx.path, `expected an object schema, got ${typeof schema}`);
  }

  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(key)) {
      throw new UnsupportedSchemaError(ctx.path, `unknown keyword "${key}"`);
    }
  }

  // --- $ref -------------------------------------------------------------------------------
  if (typeof schema.$ref === 'string') {
    const target = resolveRef(schema.$ref, ctx.root, ctx.path);
    if (ctx.seen.has(target)) {
      // A recursive schema has no finite generator without a depth budget we do not model.
      throw new UnsupportedSchemaError(ctx.path, `recursive $ref ${schema.$ref}`);
    }
    const seen = new Set(ctx.seen);
    seen.add(target);
    return build(target, { ...ctx, seen });
  }

  // --- not --------------------------------------------------------------------------------
  // The ONLY form in the corpus is `{"not":{}}` = zod z.never(). Any other negation would
  // require a validator to reject against, which we deliberately do not fake.
  if ('not' in schema) {
    const negated = schema.not;
    const isEmptyNegation =
      negated === true || (isPlainObject(negated) && Object.keys(negated).length === 0);
    if (isEmptyNegation) throw new UnsatisfiableSchemaError(ctx.path);
    throw new UnsupportedSchemaError(ctx.path, 'only `not: {}` (never) is supported');
  }

  // --- const / enum -----------------------------------------------------------------------
  if ('const' in schema) return fc.constant(schema.const);
  if (Array.isArray(schema.enum)) {
    if (schema.enum.length === 0) throw new UnsatisfiableSchemaError(ctx.path);
    return fc.constantFrom(...schema.enum);
  }

  // --- combinators ------------------------------------------------------------------------
  const union = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(union)) {
    // `oneOf` means EXACTLY one branch matches. Generating from any single branch satisfies
    // that whenever the branches are disjoint, which is how zod emits discriminated unions.
    const arbs: fc.Arbitrary<unknown>[] = [];
    for (const [i, branch] of union.entries()) {
      try {
        arbs.push(build(branch, { ...ctx, path: `${ctx.path}/anyOf/${i}` }));
      } catch (err) {
        // A never-branch is a normal part of a union; it just contributes nothing.
        if (!(err instanceof UnsatisfiableSchemaError)) throw err;
      }
    }
    if (arbs.length === 0) throw new UnsatisfiableSchemaError(ctx.path);
    return arbs.length === 1 ? arbs[0]! : fc.oneof(...arbs);
  }

  if (Array.isArray(schema.allOf)) {
    // Only the object-merge case is sound to synthesise; a general intersection needs a
    // validator. Merging disjoint object branches is exactly what zod's .and() emits.
    const merged: JsonSchema = { type: 'object', properties: {}, required: [] };
    for (const branch of schema.allOf) {
      if (!isPlainObject(branch) || branch.type !== 'object') {
        throw new UnsupportedSchemaError(ctx.path, 'allOf is only supported over object schemas');
      }
      Object.assign(merged.properties as JsonSchema, (branch.properties as JsonSchema) ?? {});
      if (Array.isArray(branch.required)) {
        (merged.required as unknown[]).push(...branch.required);
      }
    }
    return build(merged, ctx);
  }

  // --- type -------------------------------------------------------------------------------
  const type = schema.type;
  if (Array.isArray(type)) {
    const arbs = type.map((t) => build({ ...schema, type: t }, ctx));
    return arbs.length === 1 ? arbs[0]! : fc.oneof(...arbs);
  }
  if (type === undefined) {
    // No type and no combinator: an unconstrained schema. Legal, and `{}` appears as a
    // property schema for genuinely free-form payloads.
    return fc.anything({ maxDepth: 2 });
  }
  if (typeof type !== 'string') {
    throw new UnsupportedSchemaError(ctx.path, `"type" must be a string or array`);
  }

  switch (type) {
    case 'null':
      return fc.constant(null);
    case 'boolean':
      return fc.boolean();
    case 'string':
      return buildString(schema, ctx);
    case 'integer':
    case 'number':
      return buildNumber(schema, ctx, type === 'integer');
    case 'array':
      return buildArray(schema, ctx);
    case 'object':
      return buildObject(schema, ctx);
    default:
      throw new UnsupportedSchemaError(ctx.path, `unknown type "${type}"`);
  }
}

function buildString(schema: JsonSchema, ctx: Ctx): fc.Arbitrary<unknown> {
  const format = typeof schema.format === 'string' ? schema.format : undefined;
  if (format) {
    const make = FORMAT_ARBITRARIES[format];
    if (!make) throw new UnsupportedSchemaError(ctx.path, `unknown string format "${format}"`);
    return make();
  }
  if (typeof schema.pattern === 'string') {
    // Anchor so the generated value matches the whole string, which is what a validator checks.
    return fc.stringMatching(new RegExp(schema.pattern));
  }
  const minLength = typeof schema.minLength === 'number' ? schema.minLength : 0;
  const maxLengthRaw = typeof schema.maxLength === 'number' ? schema.maxLength : undefined;
  const maxLength = Math.max(minLength, Math.min(maxLengthRaw ?? ctx.maxSize, maxLengthRaw ?? 512));
  if (maxLengthRaw !== undefined && maxLengthRaw < minLength) {
    throw new UnsatisfiableSchemaError(ctx.path);
  }
  return fc.string({ minLength, maxLength });
}

function buildNumber(schema: JsonSchema, ctx: Ctx, integer: boolean): fc.Arbitrary<unknown> {
  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
  let min = num(schema.minimum);
  let max = num(schema.maximum);
  const exMin = num(schema.exclusiveMinimum);
  const exMax = num(schema.exclusiveMaximum);
  const step = integer ? 1 : Number.EPSILON;
  if (exMin !== undefined) min = min === undefined ? exMin + step : Math.max(min, exMin + step);
  if (exMax !== undefined) max = max === undefined ? exMax - step : Math.min(max, exMax - step);

  const multipleOf = num(schema.multipleOf);
  if (multipleOf !== undefined) {
    if (!integer || !Number.isInteger(multipleOf) || multipleOf <= 0) {
      throw new UnsupportedSchemaError(ctx.path, 'multipleOf is only supported for positive integer steps');
    }
    const lo = Math.ceil((min ?? -(2 ** 31)) / multipleOf);
    const hi = Math.floor((max ?? 2 ** 31) / multipleOf);
    if (lo > hi) throw new UnsatisfiableSchemaError(ctx.path);
    return fc.integer({ min: lo, max: hi }).map((k) => k * multipleOf);
  }

  if (integer) {
    const lo = min === undefined ? -(2 ** 31) : Math.ceil(min);
    const hi = max === undefined ? 2 ** 31 : Math.floor(max);
    if (lo > hi) throw new UnsatisfiableSchemaError(ctx.path);
    return fc.integer({ min: lo, max: hi });
  }
  if (min !== undefined && max !== undefined && min > max) {
    throw new UnsatisfiableSchemaError(ctx.path);
  }
  return fc.double({
    min: min ?? -(2 ** 31),
    max: max ?? 2 ** 31,
    noNaN: true,
    noDefaultInfinity: true,
  });
}

function buildArray(schema: JsonSchema, ctx: Ctx): fc.Arbitrary<unknown> {
  if (Array.isArray(schema.prefixItems)) {
    const parts = schema.prefixItems.map((s, i) =>
      build(s, { ...ctx, path: `${ctx.path}/prefixItems/${i}` }),
    );
    return fc.tuple(...parts);
  }
  const itemSchema = schema.items ?? true;
  const minItems = typeof schema.minItems === 'number' ? schema.minItems : 0;
  const maxItemsRaw = typeof schema.maxItems === 'number' ? schema.maxItems : undefined;
  if (maxItemsRaw !== undefined && maxItemsRaw < minItems) {
    throw new UnsatisfiableSchemaError(ctx.path);
  }
  const maxLength = Math.max(minItems, Math.min(maxItemsRaw ?? ctx.maxSize, ctx.maxSize));

  let item: fc.Arbitrary<unknown>;
  try {
    item = build(itemSchema, { ...ctx, path: `${ctx.path}/items` });
  } catch (err) {
    // An array of `never` is satisfiable only when it is allowed to be empty.
    if (err instanceof UnsatisfiableSchemaError && minItems === 0) return fc.constant([]);
    throw err;
  }
  if (schema.uniqueItems === true) {
    return fc.uniqueArray(item, { minLength: minItems, maxLength });
  }
  return fc.array(item, { minLength: minItems, maxLength });
}

function buildObject(schema: JsonSchema, ctx: Ctx): fc.Arbitrary<unknown> {
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === 'string') : [],
  );

  const model: Record<string, fc.Arbitrary<unknown>> = {};
  const requiredKeys: string[] = [];
  for (const [key, propSchema] of Object.entries(properties)) {
    const propPath = `${ctx.path}/properties/${key}`;
    try {
      model[key] = build(propSchema, { ...ctx, path: propPath });
      if (required.has(key)) requiredKeys.push(key);
    } catch (err) {
      if (err instanceof UnsatisfiableSchemaError) {
        // z.never() as a property: impossible to supply. Required ⇒ the whole object is
        // impossible; optional ⇒ the only conforming objects omit the key entirely.
        if (required.has(key)) throw new UnsatisfiableSchemaError(propPath);
        continue;
      }
      throw err;
    }
  }

  const declared = fc.record(model, { requiredKeys });

  // `additionalProperties` absent or true ⇒ open. A schema ⇒ open with a typed value.
  const additional = schema.additionalProperties;
  if (additional === false || additional === undefined) return declared;

  const keyArb = isPlainObject(schema.propertyNames)
    ? (build(schema.propertyNames, { ...ctx, path: `${ctx.path}/propertyNames` }) as fc.Arbitrary<string>)
    : fc.string({ minLength: 1, maxLength: ctx.maxSize });

  let valueArb: fc.Arbitrary<unknown>;
  try {
    valueArb =
      additional === true
        ? fc.anything({ maxDepth: 1 })
        : build(additional, { ...ctx, path: `${ctx.path}/additionalProperties` });
  } catch (err) {
    if (err instanceof UnsatisfiableSchemaError) return declared;
    throw err;
  }

  const extras = fc.dictionary(keyArb, valueArb, { maxKeys: 2 });
  return fc.tuple(declared, extras).map(([base, extra]) => {
    // Declared properties WIN: an extra key colliding with one would violate its schema.
    const out: Record<string, unknown> = { ...(extra as Record<string, unknown>) };
    for (const [k, v] of Object.entries(base as Record<string, unknown>)) out[k] = v;
    return out;
  });
}
