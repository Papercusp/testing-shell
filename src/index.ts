/**
 * @papercusp/testing-shell — public surface.
 *
 * - registry: defineTestDomain + TestDomain/TestSection/TestRunner types (P-001)
 * - DomainTestPanel: the shared subtab shell, parameterized by dataSource (P-002)
 * - data-source: the TestingDataSource interface + wire types + the
 *   default adminTestingDataSource (P-002)
 * - TestingShell: the left-rail + panel host, parameterized by tabs /
 *   tierLabels / dataSource / customTabs (P-003)
 * - run-status: parseRunnerStatus — the per-runner result→ChipStatus
 *   contract a backend calls after running a test (P-013)
 * - junit: aggregateJUnitCases — the pure JUnit rollup both projects'
 *   CI-results views share (P-012 data layer)
 */
export * from './registry';
export * from './data-source';
export * from './run-status';
export * from './junit';
export { default as DomainTestPanel } from './DomainTestPanel';
export { default as TestingShell, tabsFromRegistry } from './TestingShell';
export type { TestingShellTab, TestingShellProps } from './TestingShell';
