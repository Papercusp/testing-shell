/**
 * Tests for the universal-tier resolution mechanism (P-006/P-007 of
 * testing-shell-cross-project-2026-06-01).
 *
 * A "universal" domain declares a logical `role` per section instead of a
 * hardcoded glob; each project supplies a role→globs map so the same domain
 * resolves against that project's repo. This fixes the latent bug where the
 * universal tier's `apps/operator/**` globs only ever matched the operator
 * repo (empty for every other harness/project).
 */
import { describe, it, expect } from 'vitest';
import {
  applyRoleGlobs,
  defineTestDomain,
  _resetTestDomainRegistry,
  type TestDomain,
} from './registry';

const domains: TestDomain[] = [
  {
    id: 'endpoints',
    label: 'Endpoints',
    description: 'Endpoint tests.',
    tier: 'universal',
    sections: [{ id: 'all', label: 'All', role: 'endpoints' }],
  },
  {
    id: 'unit',
    label: 'Unit',
    description: 'Unit tests.',
    tier: 'universal',
    sections: [
      { id: 'role-based', label: 'By role', role: 'unit' },
      { id: 'fixed', label: 'Fixed', globs: ['always/**/*.test.ts'] },
    ],
  },
];

describe('applyRoleGlobs', () => {
  it('fills a role section with the project map globs', () => {
    const out = applyRoleGlobs(domains, { endpoints: ['apps/**/__tests__/**/*.ts'], unit: ['libs/**/*.test.ts'] });
    expect(out[0].sections[0].globs).toEqual(['apps/**/__tests__/**/*.ts']);
    expect(out[1].sections[0].globs).toEqual(['libs/**/*.test.ts']);
  });

  it('leaves non-role sections untouched', () => {
    const out = applyRoleGlobs(domains, {
      endpoints: ['apps/**/*.test.ts'],
      unit: ['libs/**/*.test.ts'],
    });
    expect(out[1].sections[1].globs).toEqual(['always/**/*.test.ts']);
  });

  it('requires every declared role to have an explicit binding', () => {
    expect(() => applyRoleGlobs(domains, { unit: ['libs/**/*.test.ts'] })).toThrow(
      /missing role bindings: endpoints/,
    );
  });

  it('rejects supplied bindings that no domain declares', () => {
    expect(() => applyRoleGlobs(domains, {
      endpoints: ['apps/**/*.test.ts'],
      unit: ['libs/**/*.test.ts'],
      stale: ['nowhere/**/*.test.ts'],
    })).toThrow(/surplus role bindings: stale/);
  });

  it('accepts an explicit empty binding instead of confusing omission with intent', () => {
    const out = applyRoleGlobs(domains, { endpoints: [], unit: ['libs/**/*.test.ts'] });
    expect(out[0].sections[0].globs).toEqual([]);
  });

  it('does not mutate the input domains', () => {
    applyRoleGlobs(domains, { endpoints: ['x/**'], unit: ['y/**'] });
    expect(domains[0].sections[0].globs).toBeUndefined();
  });
});

describe('defineTestDomain section invariant', () => {
  it('accepts a section that declares only a role (no globs/runners)', () => {
    _resetTestDomainRegistry();
    expect(() =>
      defineTestDomain({
        id: 'role-only',
        label: 'Role only',
        description: '',
        tier: 'universal',
        sections: [{ id: 'all', label: 'All', role: 'endpoints' }],
      }),
    ).not.toThrow();
  });
});
