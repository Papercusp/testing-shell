// @vitest-environment jsdom
/**
 * Tests for <AiExplorePanel> — the generic Stagehand UI. Pins the prop seam:
 * the model menu comes from props (default 3), the start URL seeds from
 * defaultStartUrl, and Run is gated on a non-empty goal.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import AiExplorePanel from './AiExplorePanel';

afterEach(cleanup);

describe('AiExplorePanel', () => {
  it('renders the default model menu (3 options) and seeds the start URL', () => {
    render(<AiExplorePanel runEndpoint="/api/ai-explore" defaultStartUrl="http://localhost:3001/" defaultGoal="do a thing" />);
    const select = screen.getByLabelText(/Model/i) as HTMLSelectElement;
    expect(select.querySelectorAll('option')).toHaveLength(3);
    expect((screen.getByDisplayValue('http://localhost:3001/') as HTMLInputElement)).toBeTruthy();
  });

  it('disables Run when the goal is empty, enables it once set', () => {
    render(<AiExplorePanel runEndpoint="/api/ai-explore" defaultStartUrl="http://localhost:3001/" />);
    const run = screen.getByRole('button', { name: 'Run' }) as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Goal/i), { target: { value: 'open a page' } });
    expect((screen.getByRole('button', { name: 'Run' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('honors a custom models prop', () => {
    render(<AiExplorePanel runEndpoint="/r" defaultStartUrl="http://x/" defaultGoal="g" models={[{ value: 'gpt-4o-mini', label: 'GPT-4o mini' }]} />);
    const select = screen.getByLabelText(/Model/i) as HTMLSelectElement;
    expect(select.querySelectorAll('option')).toHaveLength(1);
    expect(screen.getByText('GPT-4o mini')).toBeTruthy();
  });
});
