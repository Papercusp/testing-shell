/**
 * Tests for persona-trait composition + persona reference resolution.
 * Run with: npx vitest run libs/testing-shell/src/llm/personas/traits.test.ts
 */
import { describe, expect, it } from 'vitest';
import { composePersonaPrompt, resolvePersona } from './traits';
import type { Persona, PersonaTraits } from '../types';

const traits = (over: Partial<PersonaTraits> = {}): PersonaTraits => ({
  verbosity: 'normal',
  politeness: 'neutral',
  clarification: 'sometimes',
  goalClarity: 'precise',
  interrupts: false,
  modality: 'text',
  ...over,
});

describe('composePersonaPrompt', () => {
  it('always opens with the simulated-user framing', () => {
    expect(composePersonaPrompt(traits())).toContain('simulated user');
  });

  it('renders each trait branch into its fragment', () => {
    const p = composePersonaPrompt(
      traits({ verbosity: 'terse', politeness: 'rude', clarification: 'never_clarifies', goalClarity: 'shifting', modality: 'voice' }),
    );
    expect(p).toContain('TERSE');
    expect(p).toContain('RUDE');
    expect(p).toContain('NEVER clarify');
    expect(p).toContain('SHIFTS');
    expect(p).toContain('VOICE');
  });

  it('includes the interrupt line only when interrupts is true', () => {
    expect(composePersonaPrompt(traits({ interrupts: true }))).toContain('INTERRUPT');
    expect(composePersonaPrompt(traits({ interrupts: false }))).not.toContain('INTERRUPT');
  });

  it('includes an upper-cased domain line only when a domain is set', () => {
    expect(composePersonaPrompt(traits({ domain: 'finance' }))).toContain('FINANCE');
    expect(composePersonaPrompt(traits())).not.toContain('domain background');
  });
});

describe('resolvePersona', () => {
  const blend: Persona = { id: 'brief-admin', description: 'a blend', traits: traits() };
  const lookup = (id: string): Persona | undefined => (id === 'brief-admin' ? blend : undefined);

  it('resolves a blend name through the lookup', () => {
    expect(resolvePersona('brief-admin', lookup)).toBe(blend);
  });

  it('throws on an unknown blend name', () => {
    expect(() => resolvePersona('nope', lookup)).toThrow(/Unknown persona blend: 'nope'/);
  });

  it('wraps a bare PersonaTraits in an inline Persona', () => {
    const resolved = resolvePersona(traits({ verbosity: 'verbose' }), lookup);
    expect(resolved.id).toBe('inline');
    expect(resolved.traits.verbosity).toBe('verbose');
  });

  it('passes a full Persona object through unchanged', () => {
    expect(resolvePersona(blend, lookup)).toBe(blend);
  });
});
