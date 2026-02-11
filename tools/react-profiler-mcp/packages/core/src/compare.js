function aggregateByComponentName(summary) {
  const byName = new Map();

  for (const commit of summary.commits || []) {
    for (const component of commit.components || []) {
      const name = component.componentName || 'Unknown';
      const aggregate =
        byName.get(name) || {
          componentName: name,
          renderCount: 0,
          totalSelfMs: 0,
          totalSubtreeMs: 0,
          maxSubtreeMs: 0,
          commitIndices: [],
        };

      aggregate.renderCount += 1;
      aggregate.totalSelfMs += component.selfMs || 0;
      aggregate.totalSubtreeMs += component.subtreeMs || 0;
      aggregate.maxSubtreeMs = Math.max(
        aggregate.maxSubtreeMs,
        component.subtreeMs || 0,
      );
      aggregate.commitIndices.push(commit.index);

      byName.set(name, aggregate);
    }
  }

  return byName;
}

function summarizeCommitDistribution(summary) {
  const durations = (summary.commits || []).map(commit => commit.durationMs || 0);
  const total = durations.reduce((sum, value) => sum + value, 0);
  const average = durations.length > 0 ? total / durations.length : 0;
  return {
    commitCount: durations.length,
    totalCommitDurationMs: total,
    averageCommitDurationMs: average,
  };
}

export function compareSummaries(beforeSummary, afterSummary) {
  const beforeByName = aggregateByComponentName(beforeSummary);
  const afterByName = aggregateByComponentName(afterSummary);

  const allNames = new Set([...beforeByName.keys(), ...afterByName.keys()]);
  const componentDiffs = [];

  for (const componentName of allNames) {
    const before =
      beforeByName.get(componentName) ||
      {
        componentName,
        renderCount: 0,
        totalSelfMs: 0,
        totalSubtreeMs: 0,
        maxSubtreeMs: 0,
      };
    const after =
      afterByName.get(componentName) ||
      {
        componentName,
        renderCount: 0,
        totalSelfMs: 0,
        totalSubtreeMs: 0,
        maxSubtreeMs: 0,
      };

    const deltaRenderCount = after.renderCount - before.renderCount;
    const deltaTotalSelfMs = after.totalSelfMs - before.totalSelfMs;
    const deltaTotalSubtreeMs = after.totalSubtreeMs - before.totalSubtreeMs;

    componentDiffs.push({
      componentName,
      before,
      after,
      deltaRenderCount,
      deltaTotalSelfMs,
      deltaTotalSubtreeMs,
      classification:
        deltaTotalSubtreeMs < 0
          ? 'improved'
          : deltaTotalSubtreeMs > 0
            ? 'regressed'
            : 'unchanged',
    });
  }

  componentDiffs.sort(
    (a, b) => Math.abs(b.deltaTotalSubtreeMs) - Math.abs(a.deltaTotalSubtreeMs),
  );

  const beforeCommits = summarizeCommitDistribution(beforeSummary);
  const afterCommits = summarizeCommitDistribution(afterSummary);

  return {
    format: 'react-profiler-compare-v1',
    beforeSourcePath: beforeSummary.sourcePath || null,
    afterSourcePath: afterSummary.sourcePath || null,
    commitDiff: {
      before: beforeCommits,
      after: afterCommits,
      deltaCommitCount: afterCommits.commitCount - beforeCommits.commitCount,
      deltaTotalCommitDurationMs:
        afterCommits.totalCommitDurationMs - beforeCommits.totalCommitDurationMs,
      deltaAverageCommitDurationMs:
        afterCommits.averageCommitDurationMs -
        beforeCommits.averageCommitDurationMs,
    },
    components: componentDiffs,
    topRegressions: componentDiffs
      .filter(component => component.deltaTotalSubtreeMs > 0)
      .sort((a, b) => b.deltaTotalSubtreeMs - a.deltaTotalSubtreeMs)
      .slice(0, 15),
    topImprovements: componentDiffs
      .filter(component => component.deltaTotalSubtreeMs < 0)
      .sort((a, b) => a.deltaTotalSubtreeMs - b.deltaTotalSubtreeMs)
      .slice(0, 15),
  };
}
