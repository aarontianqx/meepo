import type { Run } from '@meepo/core';

/** Cumulative provider-reported usage; missing reports are not treated as zero-cost runs. */
export function summarizeUsage(runs: Run[], sessionIds: Set<string>, ticketIds: Set<string>) {
  const summary = {
    runCount: 0,
    reportedRunCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    costReportedRunCount: 0,
  };
  for (const run of runs) {
    if (
      !(run.work.kind === 'turn'
        ? sessionIds.has(run.work.turnRef.sessionId)
        : ticketIds.has(run.work.ticketId))
    )
      continue;
    summary.runCount++;
    if (!run.usage) continue;
    summary.reportedRunCount++;
    summary.inputTokens += run.usage.inputTokens;
    summary.outputTokens += run.usage.outputTokens;
    if (run.usage.costUsd !== undefined) {
      summary.costUsd += run.usage.costUsd;
      summary.costReportedRunCount++;
    }
  }
  return summary;
}
