// @vitest-environment jsdom
/**
 * Tests for the in-page web observer — the browser variant of `live`
 * (P-002 of testing-shell-platform-variants-2026-06-01). Mirrors the desktop
 * vitals-recorder: hooks console/window-error/unhandledrejection (+ a
 * PerformanceObserver for CLS/long-tasks where available) into a buffer.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startWebObserver, consoleArgsToMessage } from './observer';

describe('consoleArgsToMessage', () => {
  it('joins args, JSON-stringifying objects', () => {
    expect(consoleArgsToMessage(['boom', 42, { a: 1 }])).toBe('boom 42 {"a":1}');
  });
  it('handles an empty arg list', () => {
    expect(consoleArgsToMessage([])).toBe('');
  });
});

describe('startWebObserver', () => {
  let obs: ReturnType<typeof startWebObserver> | null = null;
  afterEach(() => {
    obs?.stop();
    obs = null;
  });

  it('captures console.error as a console-error event', () => {
    obs = startWebObserver();
    console.error('kaboom', 7);
    expect(obs.events.some((e) => e.kind === 'console-error' && e.message.includes('kaboom'))).toBe(true);
  });

  it('captures window error events', () => {
    obs = startWebObserver();
    window.dispatchEvent(new ErrorEvent('error', { message: 'win-oops' }));
    expect(obs.events.some((e) => e.kind === 'window-error' && e.message.includes('win-oops'))).toBe(true);
  });

  it('stop() unhooks — no capture after stop, console restored', () => {
    obs = startWebObserver();
    obs.stop();
    const before = obs.events.length;
    console.error('after-stop');
    expect(obs.events.length).toBe(before);
    obs = null; // already stopped
  });
});
