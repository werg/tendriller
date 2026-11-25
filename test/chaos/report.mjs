// Chaos report assembly. The report is self-contained: seed, configuration,
// versions, the exact action log (replayable with --replay), invariant results,
// convergence timings, final snapshots and evidence paths.
import { execFileSync } from 'node:child_process';
import { INVARIANTS } from './invariants.mjs';

export const REPORT_FORMAT = 'tendriller-chaos-report-v1';

export function harnessIdentity(root) {
  const git = args => { try { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim(); } catch { return null; } };
  return { commit: git(['rev-parse', 'HEAD']), dirty: Boolean(git(['status', '--porcelain'])), node: process.version, platform: `${process.platform}-${process.arch}` };
}

export function buildReport({ seed, config, golden, harness, browserVersion, started, finished, outcome, limits = [], evidence = {} }) {
  const results = Object.fromEntries(Object.entries(INVARIANTS).map(([name, description]) => {
    const violations = outcome.violations.filter(item => item.invariant === name);
    return [name, { description, checks: outcome.invariantChecks[name] ?? 0, violations: violations.length,
      status: violations.length ? 'failed' : (outcome.invariantChecks[name] ? 'passed' : 'not-checked') }];
  }));
  const actionCounts = {};
  for (const entry of outcome.entries) {
    const counts = actionCounts[entry.name] ??= { ok: 0, skipped: 0, error: 0 };
    counts[entry.status === 'ok' ? 'ok' : entry.status === 'error' ? 'error' : 'skipped']++;
  }
  const timings = outcome.convergence.filter(item => item.ok).map(item => item.ms);
  return {
    format: REPORT_FORMAT,
    status: outcome.violations.length ? 'failed' : 'passed',
    seed, config, startedAt: new Date(started).toISOString(), finishedAt: new Date(finished).toISOString(), durationMs: finished - started,
    versions: { harness, core: golden.core, chronolog: golden.chronolog, composition: golden.composition, browser: browserVersion },
    limits,
    summary: { actions: outcome.entries.length, actionErrors: outcome.entries.filter(entry => entry.status === 'error').length,
      violations: outcome.violations.length, heals: outcome.convergence.length,
      convergeMs: timings.length ? { min: Math.min(...timings), max: Math.max(...timings), mean: Math.round(timings.reduce((a, b) => a + b, 0) / timings.length) } : null,
      pageErrors: outcome.messages.pageErrors.length, consoleErrors: outcome.messages.consoleErrorCount, notes: outcome.notes.length },
    invariants: results,
    violations: outcome.violations,
    convergence: outcome.convergence,
    actionCounts,
    actions: outcome.entries,
    notes: outcome.notes,
    // No "selected history changed" notice exists; these are excluded
    // selected operations or not-current live views seen in tabs (empty = none observed).
    recoveries: outcome.recoveries ?? [],
    // Explicit browser key provisioning grants performed by the harness owner device.
    provisioning: outcome.provisioning ?? [],
    messages: outcome.messages,
    snapshots: outcome.snapshots,
    evidence,
  };
}

/** The replayable entries of a report (the runner re-adds the final heal). */
export function replayEntries(report) {
  if (report?.format !== REPORT_FORMAT) throw Error('Not a chaos report (format mismatch).');
  return report.actions.filter(entry => !entry.final).map(({ name, params }) => ({ name, params }));
}
