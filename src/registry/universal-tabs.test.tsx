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

  it('emits an agnostic llm tab + customTab when llm config is present, neither when omitted', () => {
    const without = buildUniversalTesting({ load: { scriptsEndpoint: '/s', runEndpoint: '/run', stopEndpoint: '/stop', resultsEndpoint: '/res' } });
    expect(without.tabs.find((t) => t.id === 'llm')).toBeUndefined();
    expect(without.customTabs.llm).toBeUndefined();

    const { tabs, customTabs } = buildUniversalTesting({
      llm: {
        scenariosEndpoint: '/api/admin/llm-tests/scenarios',
        runsEndpoint: '/api/admin/llm-tests/runs',
        runDetailEndpoint: '/api/admin/llm-tests/runs',
        findingsEndpoint: '/api/admin/llm-tests/findings',
        credentialsEndpoint: '/api/credentials',
      },
    });
    const llm = tabs.find((t) => t.id === 'llm')!;
    expect(llm).toBeTruthy();
    expect(llm.label).toBe('LLM');
    expect(llm.platform).toBeUndefined(); // agnostic — no platform tag
    expect(llm.tier).toBe('universal');
    expect(typeof customTabs.llm).toBe('function');
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
