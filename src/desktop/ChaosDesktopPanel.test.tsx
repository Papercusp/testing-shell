// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import ChaosDesktopPanel from './ChaosDesktopPanel';

afterEach(cleanup);

const wrap = (ui: React.ReactElement) =>
  render(ui, { wrapper: ({ children }) => <NuqsTestingAdapter>{children}</NuqsTestingAdapter> });

describe('ChaosDesktopPanel', () => {
  it('renders the run config + launch button', () => {
    wrap(<ChaosDesktopPanel recorderUrl="http://localhost:3055/" />);
    expect(screen.getByText('Launch recorder window')).toBeTruthy();
    expect(screen.getByLabelText('Chaos run duration')).toBeTruthy();
  });

  it('uses the durations prop for the duration options', () => {
    wrap(<ChaosDesktopPanel durations={{ '5s': 5000, '1m': 60000 }} />);
    const sel = screen.getByLabelText('Chaos run duration') as HTMLSelectElement;
    expect([...sel.options].map((o) => o.value)).toEqual(['5s', '1m']);
  });
});
