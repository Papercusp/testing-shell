// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { buildUniversalTesting } from './universal-tabs';

afterEach(cleanup);

describe('buildUniversalTesting', () => {
  it('returns nothing for an empty config', () => {
    const { tabs, customTabs } = buildUniversalTesting({});
    expect(tabs).toEqual([]);
    expect(Object.keys(customTabs)).toEqual([]);
  });

  it('emits a tab + customTab only for configured domains, with correct platform tags', () => {
    const { tabs, customTabs } = buildUniversalTesting({
      load: { scriptsEndpoint: '/s', runEndpoint: '/run', stopEndpoint: '/stop', resultsEndpoint: '/res' },
      chaosWeb: { runEndpoint: '/cw', baseUrl: 'http://localhost:3001/' },
    });
    expect(tabs.map((t) => t.id).sort()).toEqual(['chaos-web', 'load']);
    const load = tabs.find((t) => t.id === 'load')!;
    const chaos = tabs.find((t) => t.id === 'chaos-web')!;
    expect(load.platform).toBeUndefined(); // agnostic
    expect(chaos.platform).toBe('web');
    expect(load.tier).toBe('universal');
    expect(Object.keys(customTabs).sort()).toEqual(['chaos-web', 'load']);
  });

  it('emits the routes tab but NO routes customTab (renders via DomainTestPanel)', () => {
    const { tabs, customTabs } = buildUniversalTesting({ routes: { globs: ['apps/**/*.test.ts'] } });
    expect(tabs.map((t) => t.id)).toEqual(['routes']);
    expect(customTabs.routes).toBeUndefined();
  });

  it('wires live-web (agnostic) + ai-explore (web) panels that actually mount', () => {
    const { tabs, customTabs } = buildUniversalTesting({
      liveObserver: true,
      aiExplore: { runEndpoint: '/ai', defaultStartUrl: 'http://localhost:3001/' },
    });
    expect(tabs.find((t) => t.id === 'live-web')!.platform).toBeUndefined();
    expect(tabs.find((t) => t.id === 'ai-explore')!.platform).toBe('web');
    // the thunks return mountable elements
    const Live = customTabs['live-web'];
    const Ai = customTabs['ai-explore'];
    expect(() => render(Live())).not.toThrow();
    expect(() => render(Ai())).not.toThrow();
  });
});
