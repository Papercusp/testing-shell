// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { withNuqsTestingAdapter } from 'nuqs/adapters/testing';
import TestingShell, { type TestingShellProps } from './TestingShell';

vi.mock('./DomainTestPanel', () => ({
  default: ({ domainId }: { domainId: string }) => <div data-testid="domain-panel">{domainId}</div>,
}));

afterEach(cleanup);

const selected: TestingShellProps['tabs'][number] = {
  id: 'private-selected-tests', label: 'Selected private tests', hint: '', tier: 'project',
};
const fallback: TestingShellProps['tabs'][number] = {
  id: 'test-runs', label: 'Test Runs', hint: '', tier: 'project',
};
const props: TestingShellProps = {
  tabs: [fallback], tierLabels: { project: 'Project' }, defaultTabId: fallback.id,
  queryKey: 'testsTab', dataSource: {} as TestingShellProps['dataSource'],
};

describe('TestingShell registry-backed deep links', () => {
  it('selects a domain when its registry is already available', () => {
    render(<TestingShell {...props} tabs={[selected]} />, {
      wrapper: withNuqsTestingAdapter({ searchParams: '?testsTab=private-selected-tests' }),
    });
    expect(screen.getByTestId('domain-panel').textContent).toBe(selected.id);
    expect(screen.getByRole('button', { name: selected.label }).getAttribute('aria-pressed')).toBe('true');
  });

  it('honors the existing URL after the declared registry arrives', () => {
    const { rerender } = render(<TestingShell {...props} />, {
      wrapper: withNuqsTestingAdapter({ searchParams: '?testsTab=private-selected-tests' }),
    });
    expect(screen.getByTestId('domain-panel').textContent).toBe(fallback.id);
    rerender(<TestingShell {...props} tabs={[selected]} />);
    expect(screen.getByTestId('domain-panel').textContent).toBe(selected.id);
    expect(screen.getByRole('button', { name: selected.label }).getAttribute('aria-pressed')).toBe('true');
  });

  it('uses an available domain when the URL and configured default are absent from the registry', () => {
    render(<TestingShell {...props} tabs={[selected]} />, {
      wrapper: withNuqsTestingAdapter({ searchParams: '?testsTab=unknown-domain' }),
    });
    expect(screen.getByTestId('domain-panel').textContent).toBe(selected.id);
  });

  it('re-evaluates a retained deep link when a registry stops exposing that domain', () => {
    const { rerender } = render(<TestingShell {...props} tabs={[selected]} />, {
      wrapper: withNuqsTestingAdapter({ searchParams: '?testsTab=private-selected-tests' }),
    });
    expect(screen.getByTestId('domain-panel').textContent).toBe(selected.id);
    rerender(<TestingShell {...props} />);
    expect(screen.getByTestId('domain-panel').textContent).toBe(fallback.id);
  });
});
