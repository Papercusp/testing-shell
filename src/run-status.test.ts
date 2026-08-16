/**
 * Tests for parseRunnerStatus — the per-runner output→ChipStatus contract.
 *
 * P-013 of testing-shell-cross-project-2026-06-01. The harness run route
 * hardcodes vitest exit-code semantics; a cross-project consumer (Restart)
 * runs k6 + node:test too, which need their own result→status mapping.
 * This pure function is the shared contract both backends call.
 */
import { describe, it, expect } from 'vitest';
import { parseRunnerStatus } from './run-status';

describe('parseRunnerStatus', () => {
  it('maps a clean exit (0) to pass for every framework', () => {
    expect(parseRunnerStatus('vitest', { exitCode: 0 })).toBe('pass');
    expect(parseRunnerStatus('playwright', { exitCode: 0 })).toBe('pass');
    expect(parseRunnerStatus('cargo', { exitCode: 0 })).toBe('pass');
    expect(parseRunnerStatus('k6', { exitCode: 0 })).toBe('pass');
    expect(parseRunnerStatus('node', { exitCode: 0 })).toBe('pass');
  });

  it('maps a non-zero exit to fail', () => {
    expect(parseRunnerStatus('vitest', { exitCode: 1 })).toBe('fail');
    // k6 exits non-zero when a threshold is breached.
    expect(parseRunnerStatus('k6', { exitCode: 99 })).toBe('fail');
    // node:test exits non-zero when any subtest fails.
    expect(parseRunnerStatus('node', { exitCode: 1 })).toBe('fail');
  });

  it('treats a null exit code as still running', () => {
    expect(parseRunnerStatus('vitest', { exitCode: null })).toBe('running');
  });

  it('treats an explicit cancellation as cancelled, not failed', () => {
    expect(parseRunnerStatus('vitest', { exitCode: 1, cancelled: true })).toBe('cancelled');
  });

  it('maps SIGINT/SIGTERM/SIGKILL exit codes to cancelled', () => {
    expect(parseRunnerStatus('vitest', { exitCode: 130 })).toBe('cancelled'); // 128+SIGINT
    expect(parseRunnerStatus('k6', { exitCode: 143 })).toBe('cancelled'); // 128+SIGTERM
    expect(parseRunnerStatus('node', { exitCode: 137 })).toBe('cancelled'); // 128+SIGKILL
  });

  it('maps a clean vitest exit with "no test files" output to skip', () => {
    expect(
      parseRunnerStatus('vitest', { exitCode: 0, output: 'No test files found, exiting with code 0' }),
    ).toBe('skip');
  });
});
