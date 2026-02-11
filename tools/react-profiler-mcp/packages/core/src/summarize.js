function asNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function toEntryMap(entries) {
  const map = new Map();
  if (!Array.isArray(entries)) {
    return map;
  }
  for (const entry of entries) {
    if (Array.isArray(entry) && entry.length >= 2) {
      map.set(Number(entry[0]), entry[1]);
    }
  }
  return map;
}

function summarizeChangeDescription(changeDescription) {
  if (!changeDescription || typeof changeDescription !== 'object') {
    return null;
  }

  const reasons = [];
  if (changeDescription.isFirstMount === true) reasons.push('mount');
  if (Array.isArray(changeDescription.props) && changeDescription.props.length > 0) {
    reasons.push('props');
  }
  if (Array.isArray(changeDescription.state) && changeDescription.state.length > 0) {
    reasons.push('state');
  }
  if (Array.isArray(changeDescription.context) && changeDescription.context.length > 0) {
    reasons.push('context');
  }
  if (Array.isArray(changeDescription.hooks) && changeDescription.hooks.length > 0) {
    reasons.push('hooks');
  }
  if (changeDescription.didHooksChange === true && !reasons.includes('hooks')) {
    reasons.push('hooks');
  }

  return reasons.length > 0 ? reasons.join('+') : 'unknown';
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }
  return sorted[middle];
}

function buildNameMapFromSnapshots(rootData) {
  const byFiberId = new Map();
  if (!Array.isArray(rootData?.snapshots)) {
    return byFiberId;
  }

  for (const snapshotEntry of rootData.snapshots) {
    if (!Array.isArray(snapshotEntry) || snapshotEntry.length < 2) {
      continue;
    }
    const fiberId = Number(snapshotEntry[0]);
    const node = snapshotEntry[1] || {};
    const displayName =
      (typeof node.displayName === 'string' && node.displayName) ||
      (Array.isArray(node.hocDisplayNames) &&
      typeof node.hocDisplayNames[0] === 'string'
        ? node.hocDisplayNames[0]
        : null) ||
      `Unknown#${fiberId}`;

    byFiberId.set(fiberId, displayName);
  }

  return byFiberId;
}

function annotateGcJitter(summary) {
  const componentSpikes = new Map();
  const commitComponentIndex = new Map();

  for (const commit of summary.commits) {
    const componentMap = new Map();
    for (const component of commit.components) {
      componentMap.set(component.componentInstanceKey, component);

      const existing = componentSpikes.get(component.componentInstanceKey) || [];
      existing.push({
        commitIndex: commit.index,
        subtreeMs: component.subtreeMs,
      });
      componentSpikes.set(component.componentInstanceKey, existing);
    }
    commitComponentIndex.set(commit.index, componentMap);
  }

  for (const [instanceKey, samples] of componentSpikes.entries()) {
    if (samples.length < 3) {
      continue;
    }

    const baseline = median(samples.map(sample => sample.subtreeMs));
    if (baseline <= 0) {
      continue;
    }

    for (let i = 1; i < samples.length - 1; i += 1) {
      const prev = samples[i - 1];
      const curr = samples[i];
      const next = samples[i + 1];
      const spikeMs = curr.subtreeMs - baseline;

      const isSpike = curr.subtreeMs >= baseline * 1.8 && spikeMs >= 6;
      const neighborsNormal =
        prev.subtreeMs <= baseline * 1.4 && next.subtreeMs <= baseline * 1.4;

      if (!isSpike || !neighborsNormal) {
        continue;
      }

      const commitEntry = commitComponentIndex
        .get(curr.commitIndex)
        ?.get(instanceKey);
      if (commitEntry) {
        commitEntry.gcJitterSuspected = true;
        commitEntry.gcJitterReason =
          'One-off timing spike relative to local baseline; likely runtime noise (e.g. GC).';
      }

      const aggregate = summary.componentsByInstance.find(
        component => component.componentInstanceKey === instanceKey,
      );
      if (aggregate) {
        if (!Array.isArray(aggregate.gcJitterSuspectedSpikes)) {
          aggregate.gcJitterSuspectedSpikes = [];
        }
        aggregate.gcJitterSuspectedSpikes.push({
          commitIndex: curr.commitIndex,
          observedSubtreeMs: curr.subtreeMs,
          baselineSubtreeMs: baseline,
          deltaMs: spikeMs,
        });
      }
    }
  }
}

export function summarizeDevToolsProfile(profile, options = {}) {
  const sourcePath = options.sourcePath || null;

  if (!profile || typeof profile !== 'object') {
    throw new Error('Expected a React DevTools profile JSON object');
  }
  if (!Array.isArray(profile.dataForRoots)) {
    throw new Error('Expected profile.dataForRoots to be an array');
  }

  const commits = [];
  const componentsByInstanceMap = new Map();
  const renderedComponentNames = new Set();

  for (const rootData of profile.dataForRoots) {
    const rootID = Number(rootData.rootID);
    const rootDisplayName = rootData.displayName || `Root#${rootID}`;
    const fiberNameMap = buildNameMapFromSnapshots(rootData);

    const commitDataList = Array.isArray(rootData.commitData)
      ? rootData.commitData
      : [];

    for (let commitIndex = 0; commitIndex < commitDataList.length; commitIndex += 1) {
      const commitData = commitDataList[commitIndex] || {};
      const actualMap = toEntryMap(commitData.fiberActualDurations);
      const selfMap = toEntryMap(commitData.fiberSelfDurations);
      const changeMap = toEntryMap(commitData.changeDescriptions);
      const fiberIds = new Set([...actualMap.keys(), ...selfMap.keys()]);

      const components = [];
      for (const fiberId of fiberIds) {
        const componentName = fiberNameMap.get(fiberId) || `Unknown#${fiberId}`;
        const selfMs = asNumber(selfMap.get(fiberId));
        const subtreeMs = asNumber(actualMap.get(fiberId));
        const changeDescription = changeMap.get(fiberId) || null;
        const reasonSummary = summarizeChangeDescription(changeDescription);

        const componentInstanceKey = `${rootID}:${fiberId}`;
        const componentRecord = {
          componentInstanceKey,
          rootID,
          rootDisplayName,
          fiberId,
          componentName,
          selfMs,
          subtreeMs,
          reasonSummary,
          changeDescription,
        };

        components.push(componentRecord);
        renderedComponentNames.add(componentName);

        const aggregate =
          componentsByInstanceMap.get(componentInstanceKey) ||
          {
            componentInstanceKey,
            rootID,
            rootDisplayName,
            fiberId,
            componentName,
            renderCount: 0,
            totalSelfMs: 0,
            totalSubtreeMs: 0,
            maxSubtreeMs: 0,
            gcJitterSuspectedSpikes: [],
          };

        aggregate.renderCount += 1;
        aggregate.totalSelfMs += selfMs;
        aggregate.totalSubtreeMs += subtreeMs;
        aggregate.maxSubtreeMs = Math.max(aggregate.maxSubtreeMs, subtreeMs);

        componentsByInstanceMap.set(componentInstanceKey, aggregate);
      }

      components.sort((a, b) => b.subtreeMs - a.subtreeMs);
      commits.push({
        index: commits.length,
        rootID,
        rootDisplayName,
        rootCommitIndex: commitIndex,
        timestampMs: asNumber(commitData.timestamp),
        durationMs: asNumber(commitData.duration),
        componentCount: components.length,
        components,
      });
    }
  }

  const componentsByInstance = Array.from(componentsByInstanceMap.values())
    .map(component => ({
      ...component,
      averageSelfMs:
        component.renderCount > 0
          ? component.totalSelfMs / component.renderCount
          : 0,
      averageSubtreeMs:
        component.renderCount > 0
          ? component.totalSubtreeMs / component.renderCount
          : 0,
    }))
    .sort((a, b) => b.totalSubtreeMs - a.totalSubtreeMs);

  const summary = {
    format: 'react-profiler-summary-v1',
    sourcePath,
    profileVersion: profile.version ?? null,
    rootCount: profile.dataForRoots.length,
    commitCount: commits.length,
    totalCommitDurationMs: commits.reduce((sum, commit) => sum + commit.durationMs, 0),
    renderedComponentNames: Array.from(renderedComponentNames).sort((a, b) =>
      a.localeCompare(b),
    ),
    commits,
    componentsByInstance,
    limitations: [
      'Component names are derived from snapshot data in the export; nodes added after profiling starts may be labeled Unknown#<id>.',
      'GC jitter detection is heuristic and should be used as a hint, not a ground truth signal.',
    ],
  };

  annotateGcJitter(summary);

  return summary;
}
