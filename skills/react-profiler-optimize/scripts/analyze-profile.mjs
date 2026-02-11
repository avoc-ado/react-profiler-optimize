#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--input" || token === "-i") {
      args.input = argv[++i];
      continue;
    }
    if (token === "--output" || token === "-o") {
      args.output = argv[++i];
      continue;
    }
    if (token === "--source-root" || token === "-s") {
      args.sourceRoot = argv[++i];
      continue;
    }
    if (token === "--no-hook-name-enrichment") {
      args.enableHookNameEnrichment = false;
      continue;
    }
    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/analyze-profile.mjs --input <profile-or-trace.json> [--output <report.json>] [--source-root <repo-root>] [--no-hook-name-enrichment]",
    "",
    "Supported inputs:",
    "  - Chrome DevTools trace JSON (traceEvents), including React 19 Components track events",
    "  - React DevTools Profiler export JSON (normalized component-level analysis)",
  ].join("\n");
}

const ELEMENT_TYPE_ROOT = 11;

const TREE_OPERATION_ADD = 1;
const TREE_OPERATION_REMOVE = 2;
const TREE_OPERATION_REORDER_CHILDREN = 3;
const TREE_OPERATION_UPDATE_TREE_BASE_DURATION = 4;
const TREE_OPERATION_UPDATE_ERRORS_OR_WARNINGS = 5;
const TREE_OPERATION_SET_SUBTREE_MODE = 7;
const SUSPENSE_TREE_OPERATION_ADD = 8;
const SUSPENSE_TREE_OPERATION_REMOVE = 9;
const SUSPENSE_TREE_OPERATION_REORDER_CHILDREN = 10;
const SUSPENSE_TREE_OPERATION_RESIZE = 11;
const SUSPENSE_TREE_OPERATION_SUSPENDERS = 12;
const TREE_OPERATION_APPLIED_ACTIVITY_SLICE_CHANGE = 13;

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function round(num, digits = 2) {
  if (!Number.isFinite(num)) return 0;
  const factor = 10 ** digits;
  return Math.round(num * factor) / factor;
}

function summarizeCadence(timestampsMs) {
  if (!timestampsMs || timestampsMs.length < 4) {
    return {
      samples: timestampsMs ? timestampsMs.length : 0,
      medianDeltaMs: null,
      regularity: null,
      likelyIntervalChurn: false,
    };
  }

  const sorted = [...timestampsMs].sort((a, b) => a - b);
  const deltas = [];
  for (let i = 1; i < sorted.length; i++) {
    deltas.push(sorted[i] - sorted[i - 1]);
  }

  const medianDeltaMs = median(deltas);
  const tolerance = Math.max(40, (medianDeltaMs || 0) * 0.2);
  const regularMatches = deltas.filter((d) => Math.abs(d - (medianDeltaMs || 0)) <= tolerance).length;
  const regularity = deltas.length ? regularMatches / deltas.length : 0;

  const likelyIntervalChurn =
    Boolean(medianDeltaMs) &&
    medianDeltaMs >= 700 &&
    medianDeltaMs <= 1300 &&
    regularity >= 0.5 &&
    deltas.length >= 3;

  return {
    samples: sorted.length,
    medianDeltaMs: round(medianDeltaMs ?? 0),
    regularity: round(regularity, 3),
    likelyIntervalChurn,
  };
}

function asMsFromTraceDuration(durationMaybeUs) {
  if (!Number.isFinite(durationMaybeUs)) return 0;
  return durationMaybeUs / 1000;
}

function getComponentNameFromTraceEvent(event) {
  const argsData = event?.args?.data ?? {};
  if (typeof argsData.componentName === "string" && argsData.componentName.trim()) {
    return argsData.componentName.trim();
  }
  if (typeof argsData.displayName === "string" && argsData.displayName.trim()) {
    return argsData.displayName.trim();
  }

  const name = String(event?.name ?? "");
  const reactGlyphMatch = name.match(/⚛\s*([A-Za-z0-9_.$-]+)/);
  if (reactGlyphMatch) {
    return reactGlyphMatch[1];
  }

  const titleCaseMatch = name.match(/\b([A-Z][A-Za-z0-9_$]+)\b/);
  if (titleCaseMatch) {
    return titleCaseMatch[1];
  }

  return name || "unknown-react-event";
}

function isReactLikeTraceEvent(event) {
  const name = String(event?.name ?? "");
  const cat = String(event?.cat ?? "");
  const argsData = event?.args?.data ?? {};

  if (name.includes("⚛")) return true;
  if (/react/i.test(name)) return true;
  if (/react/i.test(cat)) return true;
  if (typeof argsData.componentName === "string") return true;
  if (typeof argsData.displayName === "string") return true;

  return false;
}

function isReactComponentsTrackEvent(event) {
  const argsData = event?.args?.data ?? {};
  const track = String(argsData?.track ?? "");
  if (track.includes("Components")) {
    return true;
  }
  if (track.includes("Server Components")) {
    return true;
  }
  return false;
}

function isReactSchedulerTrackEvent(event) {
  const argsData = event?.args?.data ?? {};
  const trackGroup = String(argsData?.trackGroup ?? "");
  return trackGroup.includes("Scheduler ⚛");
}

function getComponentNameFromTrackEvent(event) {
  const argsData = event?.args?.data ?? {};
  if (typeof argsData?.name === "string" && argsData.name.trim()) {
    return argsData.name.trim();
  }
  if (typeof argsData?.message === "string" && argsData.message.trim()) {
    return argsData.message.trim();
  }
  if (typeof argsData?.componentName === "string" && argsData.componentName.trim()) {
    return argsData.componentName.trim();
  }
  if (typeof argsData?.displayName === "string" && argsData.displayName.trim()) {
    return argsData.displayName.trim();
  }
  if (typeof event?.name === "string" && event.name.trim()) {
    return event.name.trim();
  }
  return "unknown-react-component";
}

function analyzeChromeTrace(inputPath, data) {
  const traceEvents = Array.isArray(data)
    ? data
    : Array.isArray(data?.traceEvents)
      ? data.traceEvents
      : [];

  const durationEvents = traceEvents.filter((e) => Number.isFinite(e?.dur) && e.dur > 0);
  const reactDurationEvents = durationEvents.filter(isReactLikeTraceEvent);
  const componentTrackEvents = traceEvents.filter(isReactComponentsTrackEvent);
  const schedulerTrackEvents = traceEvents.filter(isReactSchedulerTrackEvent);

  const hotspotMap = new Map();
  let totalReactTimeMs = 0;

  for (const event of reactDurationEvents) {
    const name = getComponentNameFromTraceEvent(event);
    const durationMs = asMsFromTraceDuration(event.dur);
    totalReactTimeMs += durationMs;

    const prev = hotspotMap.get(name) ?? { name, count: 0, totalMs: 0, durationCount: 0, trackCount: 0 };
    prev.durationCount += 1;
    prev.count = Math.max(prev.count, prev.durationCount, prev.trackCount);
    prev.totalMs += durationMs;
    hotspotMap.set(name, prev);
  }

  const componentTimestampsByName = new Map();
  for (const event of componentTrackEvents) {
    const name = getComponentNameFromTrackEvent(event);
    const prev = hotspotMap.get(name) ?? { name, count: 0, totalMs: 0, durationCount: 0, trackCount: 0 };
    prev.trackCount += 1;
    prev.count = Math.max(prev.count, prev.durationCount, prev.trackCount);
    hotspotMap.set(name, prev);

    const tsMs = Number.isFinite(event?.ts) ? event.ts / 1000 : null;
    if (tsMs !== null) {
      const list = componentTimestampsByName.get(name) ?? [];
      list.push(tsMs);
      componentTimestampsByName.set(name, list);
    }
  }

  const schedulerLaneCounts = new Map();
  const schedulerPhaseCounts = new Map();
  for (const event of schedulerTrackEvents) {
    const argsData = event?.args?.data ?? {};
    const lane = String(argsData?.track ?? "").trim();
    if (lane) {
      schedulerLaneCounts.set(lane, (schedulerLaneCounts.get(lane) ?? 0) + 1);
    }

    const phase = String(argsData?.name ?? argsData?.message ?? event?.name ?? "").trim();
    if (phase) {
      schedulerPhaseCounts.set(phase, (schedulerPhaseCounts.get(phase) ?? 0) + 1);
    }
  }

  const commitEvents = reactDurationEvents.filter((e) => /commit/i.test(String(e?.name ?? "")));
  const commitDurationsMs = commitEvents.map((e) => asMsFromTraceDuration(e.dur));
  const commitTimestampsMs = commitEvents
    .map((e) => (Number.isFinite(e?.ts) ? e.ts / 1000 : null))
    .filter((x) => x !== null);

  const topComponentTrackCounts = [...componentTimestampsByName.entries()]
    .map(([name, ts]) => ({ name, count: ts.length }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 25);

  const topComponentCadence = [...componentTimestampsByName.entries()]
    .map(([name, ts]) => ({ name, count: ts.length, cadence: summarizeCadence(ts) }))
    .filter((item) => item.cadence.samples >= 4)
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)
    .map((item) => ({
      name: item.name,
      count: item.count,
      medianDeltaMs: item.cadence.medianDeltaMs,
      regularity: item.cadence.regularity,
      likelyIntervalChurn: item.cadence.likelyIntervalChurn,
    }));

  const topSchedulerLanes = [...schedulerLaneCounts.entries()]
    .map(([lane, count]) => ({ lane, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const topSchedulerPhases = [...schedulerPhaseCounts.entries()]
    .map(([phase, count]) => ({ phase, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 25);

  const cadence = summarizeCadence(commitTimestampsMs);
  if (!cadence.samples && topComponentCadence.length > 0) {
    const fallback =
      topComponentCadence.find((item) => item.likelyIntervalChurn) ??
      topComponentCadence.find((item) => Number.isFinite(item.medianDeltaMs) && item.medianDeltaMs >= 100) ??
      topComponentCadence[0];
    cadence.samples = fallback.count;
    cadence.medianDeltaMs = fallback.medianDeltaMs;
    cadence.regularity = fallback.regularity;
    cadence.likelyIntervalChurn = fallback.likelyIntervalChurn;
  }

  const hotspots = [...hotspotMap.values()]
    .map((h) => ({
      name: h.name,
      count: h.count,
      totalMs: round(h.totalMs),
      avgMs: round(h.totalMs / Math.max(1, h.count)),
      durationCount: h.durationCount,
      trackCount: h.trackCount,
    }))
    .sort((a, b) => {
      if (b.totalMs !== a.totalMs) return b.totalMs - a.totalMs;
      if (b.trackCount !== a.trackCount) return b.trackCount - a.trackCount;
      return b.count - a.count;
    })
    .slice(0, 25);

  return {
    source: path.resolve(inputPath),
    mode: "chrome-trace",
    generatedAt: new Date().toISOString(),
    totals: {
      reactEvents: reactDurationEvents.length + componentTrackEvents.length + schedulerTrackEvents.length,
      reactDurationEvents: reactDurationEvents.length,
      reactComponentTrackEvents: componentTrackEvents.length,
      reactSchedulerTrackEvents: schedulerTrackEvents.length,
      reactTimeMs: round(totalReactTimeMs),
      commits: commitEvents.length,
      avgCommitMs: round(median(commitDurationsMs) ?? 0),
      p95CommitMs: round(percentile(commitDurationsMs, 95) ?? 0),
    },
    cadence,
    reactTracks: {
      componentsTrackDetected: componentTrackEvents.length > 0,
      topComponentCounts: topComponentTrackCounts,
      topComponentCadence,
      schedulerTrackDetected: schedulerTrackEvents.length > 0,
      topSchedulerLanes,
      topSchedulerPhases,
    },
    warnings:
      componentTrackEvents.length > 0 && reactDurationEvents.length < componentTrackEvents.length * 0.1
        ? [
            "React component track data is mostly timestamp events; rely on trackCount and cadence as primary signals for rerender churn.",
          ]
        : [],
    commits: [],
    hotspots,
  };
}

function pickNumber(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function sumNumericArray(values) {
  if (!Array.isArray(values)) return 0;
  let total = 0;
  for (const value of values) {
    if (Number.isFinite(value)) total += value;
  }
  return total;
}

function normalizePairEntries(value) {
  if (!Array.isArray(value)) return [];

  const pairs = [];
  for (let i = 0; i < value.length; i++) {
    const item = value[i];

    if (Array.isArray(item) && item.length >= 2) {
      const key = Number(item[0]);
      if (Number.isFinite(key)) {
        pairs.push([key, item[1]]);
      }
      continue;
    }

    if (Number.isFinite(Number(item)) && Number.isFinite(Number(value[i + 1]))) {
      pairs.push([Number(item), Number(value[i + 1])]);
      i += 1;
    }
  }
  return pairs;
}

function toPairMap(value) {
  return new Map(normalizePairEntries(value));
}

function getSnapshotDisplayName(node) {
  if (!node || typeof node !== "object") return null;

  if (typeof node.displayName === "string" && node.displayName.trim()) {
    return node.displayName.trim();
  }
  if (Array.isArray(node.hocDisplayNames) && typeof node.hocDisplayNames[0] === "string") {
    return node.hocDisplayNames[0];
  }
  return null;
}

function buildFiberNameMap(root, rootName) {
  const map = new Map();
  const snapshots = normalizePairEntries(root?.snapshots);
  for (const [fiberId, node] of snapshots) {
    const displayName = getSnapshotDisplayName(node);
    if (displayName) {
      map.set(fiberId, displayName);
    }
  }

  if (!map.size) {
    map.set(-1, rootName);
  }
  return map;
}

function decodeStringFromOperations(operations, startIndex, length) {
  if (!Number.isFinite(startIndex) || !Number.isFinite(length) || length <= 0) {
    return "";
  }
  const chars = [];
  for (let i = 0; i < length; i++) {
    const codePoint = Number(operations[startIndex + i]);
    if (!Number.isFinite(codePoint)) continue;
    chars.push(String.fromCodePoint(codePoint));
  }
  return chars.join("");
}

function buildInitialCommitTree(root) {
  const rootIDFromExport = Number(root?.rootID);
  const initialTreeBaseDurations = toPairMap(root?.initialTreeBaseDurations);
  const snapshotEntries = normalizePairEntries(root?.snapshots);

  const nodes = new Map();
  for (const [fiberId, snapshotNode] of snapshotEntries) {
    const children = Array.isArray(snapshotNode?.children)
      ? snapshotNode.children
          .map((childID) => Number(childID))
          .filter((childID) => Number.isFinite(childID))
      : [];

    nodes.set(fiberId, {
      id: fiberId,
      parentID: 0,
      children,
      displayName: getSnapshotDisplayName(snapshotNode),
      hocDisplayNames: Array.isArray(snapshotNode?.hocDisplayNames)
        ? snapshotNode.hocDisplayNames.filter((hocName) => typeof hocName === "string")
        : null,
      key: snapshotNode?.key ?? null,
      type: Number.isFinite(snapshotNode?.type) ? Number(snapshotNode.type) : null,
      compiledWithForget: snapshotNode?.compiledWithForget === true,
      treeBaseDuration: Number(initialTreeBaseDurations.get(fiberId) ?? 0),
    });
  }

  for (const [fiberId, node] of nodes) {
    for (const childID of node.children) {
      const childNode = nodes.get(childID);
      if (childNode) {
        childNode.parentID = fiberId;
      }
    }
  }

  let rootID = Number.isFinite(rootIDFromExport) ? rootIDFromExport : null;
  if (!Number.isFinite(rootID) || !nodes.has(rootID)) {
    const rootLikeNode = [...nodes.values()].find((node) => node.type === ELEMENT_TYPE_ROOT);
    rootID = rootLikeNode?.id ?? [...nodes.values()].find((node) => node.parentID === 0)?.id ?? null;
  }
  if (!Number.isFinite(rootID) && nodes.size > 0) {
    rootID = nodes.keys().next().value;
  }
  if (!Number.isFinite(rootID)) {
    rootID = 0;
  }

  return {
    rootID,
    nodes,
  };
}

function addWarningOnce(warningSet, warning) {
  if (warningSet && typeof warning === "string" && warning.length > 0) {
    warningSet.add(warning);
  }
}

function applyOperationsToCommitTree(commitTree, operations, warningSet) {
  if (!Array.isArray(operations) || operations.length < 3) {
    return;
  }

  const nodes = commitTree.nodes;
  let i = 2;

  const stringTable = [null];
  const stringTableSize = Number(operations[i++]);
  if (!Number.isFinite(stringTableSize) || stringTableSize < 0) {
    addWarningOnce(warningSet, "Invalid operation string table encountered; skipping commit tree mutation.");
    return;
  }

  const stringTableEnd = Math.min(operations.length, i + stringTableSize);
  while (i < stringTableEnd) {
    const nextLength = Number(operations[i++]);
    if (!Number.isFinite(nextLength) || nextLength < 0 || i + nextLength > operations.length) {
      addWarningOnce(
        warningSet,
        "Malformed operation string payload encountered; commit tree may be partially reconstructed.",
      );
      return;
    }
    const decoded = decodeStringFromOperations(operations, i, nextLength);
    stringTable.push(decoded);
    i += nextLength;
  }

  while (i < operations.length) {
    const operation = Number(operations[i]);

    switch (operation) {
      case TREE_OPERATION_ADD: {
        const id = Number(operations[i + 1]);
        const type = Number(operations[i + 2]);
        i += 3;

        if (!Number.isFinite(id)) {
          addWarningOnce(warningSet, "Encountered TREE_OPERATION_ADD with invalid fiber id.");
          break;
        }

        if (type === ELEMENT_TYPE_ROOT) {
          i += 4;
          nodes.set(id, {
            id,
            children: [],
            displayName: null,
            hocDisplayNames: null,
            key: null,
            parentID: 0,
            treeBaseDuration: 0,
            type,
            compiledWithForget: false,
          });
          commitTree.rootID = id;
          break;
        }

        const parentID = Number(operations[i]);
        i += 1;
        i += 1; // ownerID
        const displayNameStringID = Number(operations[i]);
        i += 1;
        const keyStringID = Number(operations[i]);
        i += 1;
        i += 1; // name prop string ID

        const existing = nodes.get(id);
        if (existing && Number.isFinite(existing.parentID)) {
          const oldParent = nodes.get(existing.parentID);
          if (oldParent) {
            oldParent.children = oldParent.children.filter((childID) => childID !== id);
          }
        }

        const parentNode = nodes.get(parentID);
        if (parentNode && !parentNode.children.includes(id)) {
          parentNode.children = parentNode.children.concat(id);
        }

        nodes.set(id, {
          id,
          children: existing?.children ?? [],
          displayName:
            typeof stringTable[displayNameStringID] === "string" ? stringTable[displayNameStringID] : null,
          hocDisplayNames: existing?.hocDisplayNames ?? null,
          key: stringTable[keyStringID] ?? null,
          parentID: Number.isFinite(parentID) ? parentID : 0,
          treeBaseDuration: Number(existing?.treeBaseDuration ?? 0),
          type: Number.isFinite(type) ? type : existing?.type ?? null,
          compiledWithForget: existing?.compiledWithForget === true,
        });
        break;
      }
      case TREE_OPERATION_REMOVE: {
        const removeLength = Number(operations[i + 1]);
        i += 2;
        if (!Number.isFinite(removeLength) || removeLength < 0) {
          addWarningOnce(warningSet, "Encountered TREE_OPERATION_REMOVE with invalid remove length.");
          break;
        }

        for (let removeIndex = 0; removeIndex < removeLength && i < operations.length; removeIndex++) {
          const id = Number(operations[i++]);
          if (!Number.isFinite(id)) continue;

          const node = nodes.get(id);
          if (!node) continue;

          if (Number.isFinite(node.parentID)) {
            const parentNode = nodes.get(node.parentID);
            if (parentNode) {
              parentNode.children = parentNode.children.filter((childID) => childID !== id);
            }
          }
          nodes.delete(id);
        }
        break;
      }
      case TREE_OPERATION_REORDER_CHILDREN: {
        const id = Number(operations[i + 1]);
        const numChildren = Number(operations[i + 2]);
        i += 3;

        if (!Number.isFinite(numChildren) || numChildren < 0) {
          addWarningOnce(warningSet, "Encountered TREE_OPERATION_REORDER_CHILDREN with invalid child count.");
          break;
        }

        const children = [];
        for (let childIndex = 0; childIndex < numChildren && i < operations.length; childIndex++) {
          const childID = Number(operations[i++]);
          if (Number.isFinite(childID)) children.push(childID);
        }

        const node = nodes.get(id);
        if (node) {
          node.children = children;
          for (const childID of children) {
            const childNode = nodes.get(childID);
            if (childNode) childNode.parentID = id;
          }
        }
        break;
      }
      case TREE_OPERATION_SET_SUBTREE_MODE: {
        i += 3;
        break;
      }
      case TREE_OPERATION_UPDATE_TREE_BASE_DURATION: {
        const id = Number(operations[i + 1]);
        const durationUs = Number(operations[i + 2]);
        i += 3;
        const node = nodes.get(id);
        if (node && Number.isFinite(durationUs)) {
          node.treeBaseDuration = durationUs / 1000;
        }
        break;
      }
      case TREE_OPERATION_UPDATE_ERRORS_OR_WARNINGS: {
        i += 4;
        break;
      }
      case SUSPENSE_TREE_OPERATION_ADD: {
        const numRects = Number(operations[i + 5]);
        i += 6 + (numRects === -1 ? 0 : Math.max(0, numRects) * 4);
        break;
      }
      case SUSPENSE_TREE_OPERATION_REMOVE: {
        const removeLength = Number(operations[i + 1]);
        i += 2 + (Number.isFinite(removeLength) && removeLength > 0 ? removeLength : 0);
        break;
      }
      case SUSPENSE_TREE_OPERATION_REORDER_CHILDREN: {
        const numChildren = Number(operations[i + 2]);
        i += 3 + (Number.isFinite(numChildren) && numChildren > 0 ? numChildren : 0);
        break;
      }
      case SUSPENSE_TREE_OPERATION_RESIZE: {
        const numRects = Number(operations[i + 2]);
        i += 3 + (numRects === -1 ? 0 : Math.max(0, numRects) * 4);
        break;
      }
      case SUSPENSE_TREE_OPERATION_SUSPENDERS: {
        i += 1;
        const changeLength = Number(operations[i++]);
        const safeChangeLength = Number.isFinite(changeLength) && changeLength > 0 ? changeLength : 0;
        for (let changeIndex = 0; changeIndex < safeChangeLength && i < operations.length; changeIndex++) {
          i += 1; // suspenseNodeId
          i += 1; // hasUniqueSuspenders
          i += 1; // endTime
          i += 1; // isSuspended
          const environmentNamesLength = Number(operations[i++]);
          i +=
            Number.isFinite(environmentNamesLength) && environmentNamesLength > 0
              ? environmentNamesLength
              : 0;
        }
        break;
      }
      case TREE_OPERATION_APPLIED_ACTIVITY_SLICE_CHANGE: {
        i += 2;
        break;
      }
      default: {
        addWarningOnce(
          warningSet,
          `Encountered unknown tree operation code ${String(operation)}; commit tree reconstruction may be incomplete.`,
        );
        i += 1;
      }
    }
  }
}

function summarizeChangeDescription(changeDescription) {
  if (!changeDescription || typeof changeDescription !== "object") return null;

  const reasons = [];
  if (changeDescription.isFirstMount === true) reasons.push("mount");
  if (Array.isArray(changeDescription.props) && changeDescription.props.length > 0) reasons.push("props");
  if (Array.isArray(changeDescription.state) && changeDescription.state.length > 0) reasons.push("state");
  if (Array.isArray(changeDescription.context) && changeDescription.context.length > 0) reasons.push("context");
  if (Array.isArray(changeDescription.hooks) && changeDescription.hooks.length > 0) reasons.push("hooks");
  if (changeDescription.didHooksChange === true && !reasons.includes("hooks")) reasons.push("hooks");

  if (!reasons.length) {
    return "unknown";
  }
  return reasons.join("+");
}

function normalizeChangedKeys(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string" || Number.isFinite(item));
}

const PRIMITIVE_HOOK_NAMES = new Set([
  "use",
  "useActionState",
  "useCallback",
  "useContext",
  "useDebugValue",
  "useDeferredValue",
  "useEffect",
  "useId",
  "useImperativeHandle",
  "useInsertionEffect",
  "useLayoutEffect",
  "useMemo",
  "useOptimistic",
  "useReducer",
  "useRef",
  "useState",
  "useSyncExternalStore",
  "useTransition",
]);

function isLikelyComponentName(name) {
  return typeof name === "string" && /^[A-Z][A-Za-z0-9_$]*$/.test(name);
}

function isLikelySourceFile(filePath) {
  return /\.(c|m)?(j|t)sx?$/.test(filePath);
}

function shouldSkipDirName(name) {
  return (
    name === "node_modules" ||
    name === ".git" ||
    name === ".next" ||
    name === "dist" ||
    name === "build" ||
    name === "coverage" ||
    name === "out"
  );
}

function findMatchingBrace(source, openBraceIndex) {
  if (!Number.isFinite(openBraceIndex) || openBraceIndex < 0 || openBraceIndex >= source.length) {
    return -1;
  }

  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;

  for (let i = openBraceIndex; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (char === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inSingle) {
      if (!escaped && char === "'") inSingle = false;
      escaped = !escaped && char === "\\";
      continue;
    }
    if (inDouble) {
      if (!escaped && char === '"') inDouble = false;
      escaped = !escaped && char === "\\";
      continue;
    }
    if (inTemplate) {
      if (!escaped && char === "`") inTemplate = false;
      escaped = !escaped && char === "\\";
      continue;
    }

    if (char === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (char === "'") {
      inSingle = true;
      escaped = false;
      continue;
    }
    if (char === '"') {
      inDouble = true;
      escaped = false;
      continue;
    }
    if (char === "`") {
      inTemplate = true;
      escaped = false;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return i;
      continue;
    }
  }

  return -1;
}

function extractComponentBody(source, componentName) {
  if (typeof source !== "string" || !source.includes(componentName)) {
    return null;
  }

  const escapedName = componentName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`\\bfunction\\s+${escapedName}\\s*\\([^)]*\\)\\s*\\{`, "m"),
    new RegExp(`\\bconst\\s+${escapedName}\\s*=\\s*(?:async\\s*)?\\([^)]*\\)\\s*=>\\s*\\{`, "m"),
    new RegExp(`\\b(?:let|var)\\s+${escapedName}\\s*=\\s*(?:async\\s*)?\\([^)]*\\)\\s*=>\\s*\\{`, "m"),
    new RegExp(`\\bconst\\s+${escapedName}\\s*=\\s*function\\s*\\([^)]*\\)\\s*\\{`, "m"),
    new RegExp(`\\bexport\\s+default\\s+function\\s+${escapedName}\\s*\\([^)]*\\)\\s*\\{`, "m"),
    new RegExp(`\\bexport\\s+function\\s+${escapedName}\\s*\\([^)]*\\)\\s*\\{`, "m"),
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(source);
    if (!match) continue;

    const openBraceOffset = match[0].lastIndexOf("{");
    const openBraceIndex = openBraceOffset >= 0 ? match.index + openBraceOffset : -1;
    if (openBraceIndex < 0) continue;

    const closeBraceIndex = findMatchingBrace(source, openBraceIndex);
    if (closeBraceIndex <= openBraceIndex) continue;

    return source.slice(openBraceIndex + 1, closeBraceIndex);
  }

  return null;
}

function extractPrimitiveHookSlotsFromBody(body) {
  if (typeof body !== "string" || body.length === 0) {
    return [];
  }

  const hookCalls = [];
  const hookCallRegex = /\b(?:React\.)?(use[A-Z][A-Za-z0-9_]*|use)\s*\(/g;
  let match;
  while ((match = hookCallRegex.exec(body)) !== null) {
    const hookName = match[1];
    if (!PRIMITIVE_HOOK_NAMES.has(hookName)) continue;

    hookCalls.push({
      index: hookCalls.length,
      hookName,
    });
  }

  return hookCalls;
}

function createHookNameResolver({ sourceRoot, enabled, warningSet }) {
  const cacheByComponent = new Map();
  const stats = {
    enabled: enabled === true,
    sourceRoot: sourceRoot ?? null,
    attemptedComponents: 0,
    resolvedComponents: 0,
    unresolvedComponents: 0,
    resolvedHookSlots: 0,
    unresolvedHookSlots: 0,
  };

  const dirEntriesCache = new Map();
  const sourceFileContentsCache = new Map();

  const readDirCached = (dirPath) => {
    if (dirEntriesCache.has(dirPath)) return dirEntriesCache.get(dirPath);
    let entries = [];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      entries = [];
    }
    dirEntriesCache.set(dirPath, entries);
    return entries;
  };

  const readFileCached = (filePath) => {
    if (sourceFileContentsCache.has(filePath)) return sourceFileContentsCache.get(filePath);
    let content = null;
    try {
      const stat = fs.statSync(filePath);
      if (stat.size <= 2_000_000) {
        content = fs.readFileSync(filePath, "utf8");
      }
    } catch {
      content = null;
    }
    sourceFileContentsCache.set(filePath, content);
    return content;
  };

  const findComponentSource = (componentName) => {
    if (!sourceRoot || !isLikelyComponentName(componentName)) return null;
    const queue = [sourceRoot];
    const maxVisitedDirs = 1500;
    let visitedDirs = 0;

    while (queue.length > 0 && visitedDirs <= maxVisitedDirs) {
      const current = queue.shift();
      visitedDirs += 1;

      for (const entry of readDirCached(current)) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (shouldSkipDirName(entry.name)) continue;
          queue.push(fullPath);
          continue;
        }
        if (!entry.isFile() || !isLikelySourceFile(entry.name)) continue;

        const source = readFileCached(fullPath);
        if (!source || !source.includes(componentName)) continue;

        const body = extractComponentBody(source, componentName);
        if (body) {
          return { filePath: fullPath, body };
        }
      }
    }

    return null;
  };

  const getSlotsForComponent = (componentName) => {
    if (cacheByComponent.has(componentName)) return cacheByComponent.get(componentName);

    stats.attemptedComponents += 1;
    const sourceInfo = findComponentSource(componentName);
    if (!sourceInfo) {
      stats.unresolvedComponents += 1;
      const unresolved = { slots: [], sourceFile: null, resolved: false };
      cacheByComponent.set(componentName, unresolved);
      return unresolved;
    }

    const slots = extractPrimitiveHookSlotsFromBody(sourceInfo.body);
    if (slots.length > 0) {
      stats.resolvedComponents += 1;
    } else {
      stats.unresolvedComponents += 1;
      addWarningOnce(
        warningSet,
        `Hook name enrichment could not parse primitive hook slots for component "${componentName}" in "${sourceInfo.filePath}".`,
      );
    }

    const resolved = { slots, sourceFile: sourceInfo.filePath, resolved: slots.length > 0 };
    cacheByComponent.set(componentName, resolved);
    return resolved;
  };

  return {
    resolveHooks({ componentName, hookIndices }) {
      if (!stats.enabled || !Array.isArray(hookIndices) || hookIndices.length === 0) {
        return [];
      }
      if (!isLikelyComponentName(componentName)) {
        return [];
      }

      const slotInfo = getSlotsForComponent(componentName);
      if (!slotInfo.resolved) {
        stats.unresolvedHookSlots += hookIndices.filter(Number.isFinite).length;
        return hookIndices
          .filter(Number.isFinite)
          .map((indexValue) => ({
            index: Number(indexValue),
            primitiveHook: null,
            label: `#${Number(indexValue) + 1}`,
            sourceFile: null,
            resolved: false,
          }));
      }

      return hookIndices
        .filter(Number.isFinite)
        .map((indexValue) => {
          const index = Number(indexValue);
          const slot = slotInfo.slots[index];
          if (!slot) {
            stats.unresolvedHookSlots += 1;
            return {
              index,
              primitiveHook: null,
              label: `#${index + 1}`,
              sourceFile: slotInfo.sourceFile,
              resolved: false,
            };
          }

          stats.resolvedHookSlots += 1;
          return {
            index,
            primitiveHook: slot.hookName,
            label: `${slot.hookName} (#${index + 1})`,
            sourceFile: slotInfo.sourceFile,
            resolved: true,
          };
        });
    },
    getStats() {
      return { ...stats };
    },
  };
}

function createRuntimeHookResolver({ profileData, warningSet }) {
  const inspectedElements = profileData?.automationMeta?.inspectedElements;
  const roots = Array.isArray(inspectedElements?.roots) ? inspectedElements.roots : [];
  const globalHookNameParsing =
    inspectedElements?.hookNameParsing && typeof inspectedElements.hookNameParsing === "object"
      ? inspectedElements.hookNameParsing
      : null;

  const stats = {
    enabled: inspectedElements?.enabled === true,
    rootsScanned: roots.length,
    elementsScanned: 0,
    elementsWithHookSlots: 0,
    resolvedHookSlots: 0,
    unresolvedHookSlots: 0,
    hookNameParsing: {
      enabled: globalHookNameParsing?.enabled === true,
      timeoutMs: Number.isFinite(globalHookNameParsing?.timeoutMs)
        ? Number(globalHookNameParsing.timeoutMs)
        : null,
      requestedElements: Number.isFinite(globalHookNameParsing?.requestedElements)
        ? Number(globalHookNameParsing.requestedElements)
        : 0,
      parsedElements: Number.isFinite(globalHookNameParsing?.parsedElements)
        ? Number(globalHookNameParsing.parsedElements)
        : 0,
      parsedElementsWithNamedHooks: Number.isFinite(globalHookNameParsing?.parsedElementsWithNamedHooks)
        ? Number(globalHookNameParsing.parsedElementsWithNamedHooks)
        : 0,
      resolvedSlots: Number.isFinite(globalHookNameParsing?.resolvedSlots)
        ? Number(globalHookNameParsing.resolvedSlots)
        : 0,
      touchedSlots: Number.isFinite(globalHookNameParsing?.touchedSlots)
        ? Number(globalHookNameParsing.touchedSlots)
        : 0,
      timedOutElements: Number.isFinite(globalHookNameParsing?.timedOutElements)
        ? Number(globalHookNameParsing.timedOutElements)
        : 0,
      failedElements: Number.isFinite(globalHookNameParsing?.failedElements)
        ? Number(globalHookNameParsing.failedElements)
        : 0,
      unresolvedLocationCount: Number.isFinite(globalHookNameParsing?.unresolvedLocationCount)
        ? Number(globalHookNameParsing.unresolvedLocationCount)
        : 0,
      elementsWithDiagnostics: 0,
      elementsWithUnresolvedLocations: 0,
      fetchSummaryByResolver: {},
      unresolvedElementDiagnostics: [],
    },
  };

  const byRootFiber = new Map();
  const makeKey = (rootID, fiberID) => `${rootID}:${fiberID}`;

  for (const rootEntry of roots) {
    const rootID = Number(rootEntry?.rootID);
    const elements = Array.isArray(rootEntry?.elements) ? rootEntry.elements : [];
    for (const element of elements) {
      const fiberID = Number(element?.fiberID);
      if (!Number.isFinite(rootID) || !Number.isFinite(fiberID)) {
        continue;
      }

      stats.elementsScanned += 1;
      const slots = Array.isArray(element?.hookSlots) ? element.hookSlots : [];
      if (slots.length > 0) {
        stats.elementsWithHookSlots += 1;
      }

      const hookNameParsing =
        element?.hookNameParsing && typeof element.hookNameParsing === "object"
          ? element.hookNameParsing
          : null;
      if (hookNameParsing) {
        stats.hookNameParsing.elementsWithDiagnostics += 1;
        if (!stats.hookNameParsing.enabled) {
          stats.hookNameParsing.enabled = true;
        }

        const unresolvedLocationCount = Number.isFinite(hookNameParsing?.unresolvedLocationCount)
          ? Number(hookNameParsing.unresolvedLocationCount)
          : 0;
        const resolvedLocationCount = Number.isFinite(hookNameParsing?.resolvedLocationCount)
          ? Number(hookNameParsing.resolvedLocationCount)
          : 0;

        if (unresolvedLocationCount > 0) {
          stats.hookNameParsing.elementsWithUnresolvedLocations += 1;
          if (!globalHookNameParsing) {
            stats.hookNameParsing.unresolvedLocationCount += unresolvedLocationCount;
          }
          stats.hookNameParsing.unresolvedElementDiagnostics.push({
            rootID,
            fiberID,
            sourceFile:
              typeof element?.source?.fileName === "string" && element.source.fileName.trim()
                ? element.source.fileName
                : null,
            resolvedLocationCount,
            unresolvedLocationCount,
            timedOut: hookNameParsing?.timedOut === true,
            errorMessage:
              typeof hookNameParsing?.errorMessage === "string" && hookNameParsing.errorMessage.trim()
                ? hookNameParsing.errorMessage
                : null,
            sourceUrls: Array.isArray(hookNameParsing?.sourceUrls)
              ? hookNameParsing.sourceUrls.filter((item) => typeof item === "string").slice(0, 8)
              : [],
            unresolvedLocationKeys: Array.isArray(hookNameParsing?.unresolvedLocationKeys)
              ? hookNameParsing.unresolvedLocationKeys
                  .filter((item) => typeof item === "string")
                  .slice(0, 8)
              : [],
          });
        }

        const resolverCounts =
          hookNameParsing?.fetchSummary?.byResolver &&
          typeof hookNameParsing.fetchSummary.byResolver === "object"
            ? hookNameParsing.fetchSummary.byResolver
            : null;
        if (resolverCounts) {
          for (const [resolver, count] of Object.entries(resolverCounts)) {
            const numericCount = Number.isFinite(count) ? Number(count) : 0;
            if (numericCount <= 0) {
              continue;
            }
            stats.hookNameParsing.fetchSummaryByResolver[resolver] =
              (stats.hookNameParsing.fetchSummaryByResolver[resolver] ?? 0) + numericCount;
          }
        }
      }

      const slotByIndex = new Map();
      for (const slot of slots) {
        const index = Number(slot?.index);
        if (!Number.isFinite(index)) continue;
        slotByIndex.set(index, slot);
      }

      byRootFiber.set(makeKey(rootID, fiberID), {
        source: element?.source ?? null,
        owners: Array.isArray(element?.owners) ? element.owners : [],
        slotByIndex,
      });
    }
  }

  return {
    getElementMeta({ rootID, fiberID }) {
      if (!Number.isFinite(rootID) || !Number.isFinite(fiberID)) {
        return null;
      }
      return byRootFiber.get(makeKey(rootID, fiberID)) ?? null;
    },
    resolveHooks({ rootID, fiberID, hookIndices }) {
      if (!stats.enabled || !Array.isArray(hookIndices) || hookIndices.length === 0) {
        return [];
      }
      if (!Number.isFinite(rootID) || !Number.isFinite(fiberID)) {
        return [];
      }

      const entry = byRootFiber.get(makeKey(rootID, fiberID));
      if (!entry) {
        return [];
      }

      return hookIndices
        .filter(Number.isFinite)
        .map((indexValue) => {
          const index = Number(indexValue);
          const slot = entry.slotByIndex.get(index);
          if (!slot) {
            stats.unresolvedHookSlots += 1;
            return {
              index,
              primitiveHook: null,
              primitiveNameRaw: null,
              parsedHookName: null,
              parsedHookNameSource: null,
              label: `#${index + 1}`,
              customHookPath: [],
              sourceFile: null,
              sourceLocation: null,
              resolved: false,
              resolution: "runtime-inspect-element",
            };
          }

          const primitiveHook =
            typeof slot?.primitiveHook === "string" && slot.primitiveHook.trim()
              ? slot.primitiveHook
              : null;
          const primitiveNameRaw =
            typeof slot?.primitiveNameRaw === "string" && slot.primitiveNameRaw.trim()
              ? slot.primitiveNameRaw
              : null;
          const parsedHookName =
            typeof slot?.parsedHookName === "string" && slot.parsedHookName.trim()
              ? slot.parsedHookName
              : null;
          const parsedHookNameSource =
            typeof slot?.parsedHookNameSource === "string" && slot.parsedHookNameSource.trim()
              ? slot.parsedHookNameSource
              : null;
          const customHookPath = Array.isArray(slot?.customHookPath)
            ? slot.customHookPath.filter((name) => typeof name === "string" && name.trim())
            : [];
          const sourceLocation =
            slot?.hookSource && typeof slot.hookSource === "object" ? slot.hookSource : null;
          const sourceFile = typeof sourceLocation?.fileName === "string" ? sourceLocation.fileName : null;

          const labelBase = parsedHookName || primitiveHook || primitiveNameRaw || `#${index + 1}`;
          const labelSuffix = customHookPath.length > 0 ? ` via ${customHookPath.join(" > ")}` : "";
          const label = `${labelBase} (#${index + 1})${labelSuffix}`;

          stats.resolvedHookSlots += 1;
          return {
            index,
            primitiveHook,
            primitiveNameRaw,
            parsedHookName,
            parsedHookNameSource,
            label,
            customHookPath,
            sourceFile,
            sourceLocation,
            resolved: true,
            resolution: "runtime-inspect-element",
          };
        });
    },
    getStats() {
      const unresolvedElementDiagnostics = stats.hookNameParsing.unresolvedElementDiagnostics
        .slice()
        .sort((a, b) => b.unresolvedLocationCount - a.unresolvedLocationCount)
        .slice(0, 25);

      return {
        ...stats,
        hookNameParsing: {
          ...stats.hookNameParsing,
          unresolvedElementDiagnostics,
        },
      };
    },
  };
}

function parseRenderReasonDetails(
  changeDescription,
  {
    componentName = null,
    hookNameResolver = null,
    runtimeHookResolver = null,
    rootID = null,
    fiberID = null,
    commitUpdaterIDs = null,
  } = {},
) {
  if (!changeDescription || typeof changeDescription !== "object") return null;

  const hooksChanged = normalizeChangedKeys(changeDescription.hooks);

  let hookEnrichment = [];
  let hookEnrichmentSource = null;

  if (runtimeHookResolver) {
    hookEnrichment = runtimeHookResolver.resolveHooks({
      rootID,
      fiberID,
      hookIndices: hooksChanged.filter(Number.isFinite),
    });
    if (hookEnrichment.length > 0) {
      hookEnrichmentSource = "runtime-inspect-element";
    }
  }

  if (hookEnrichment.length === 0 && hookNameResolver && componentName) {
    hookEnrichment = hookNameResolver.resolveHooks({
      componentName,
      hookIndices: hooksChanged.filter(Number.isFinite),
    });
    if (hookEnrichment.length > 0) {
      hookEnrichmentSource = "source-static-parse";
    }
  }

  const summary = summarizeChangeDescription(changeDescription);
  const hasUnknownSummary = summary === "unknown";
  const updaterMatched =
    hasUnknownSummary &&
    commitUpdaterIDs instanceof Set &&
    Number.isFinite(fiberID) &&
    commitUpdaterIDs.has(Number(fiberID));

  return {
    summary,
    isFirstMount: changeDescription.isFirstMount === true,
    didHooksChange: changeDescription.didHooksChange === true,
    propsChanged: normalizeChangedKeys(changeDescription.props),
    stateChanged: normalizeChangedKeys(changeDescription.state),
    contextChanged: normalizeChangedKeys(changeDescription.context),
    hooksChanged,
    hooksChangedDetails: hookEnrichment,
    hooksChangedDetailsSource: hookEnrichmentSource,
    attributionStatus: hasUnknownSummary ? "unknown" : "known",
    inferredReason: updaterMatched
      ? {
          kind: "updater-match",
          confidence: "low",
          note: "Fiber is present in commit updaters; likely local state/hook update.",
        }
      : null,
  };
}

function normalizeUpdater(updater) {
  if (!updater || typeof updater !== "object") return null;
  return {
    id: Number.isFinite(updater.id) ? Number(updater.id) : null,
    displayName:
      typeof updater.displayName === "string" && updater.displayName.trim()
        ? updater.displayName.trim()
        : null,
    key: updater.key ?? null,
    type: Number.isFinite(updater.type) ? Number(updater.type) : null,
  };
}

function resolveFiberName({ fiberId, node, fallbackFiberNameMap, rootName }) {
  if (node) {
    const displayName = getSnapshotDisplayName(node);
    if (displayName) {
      return { name: displayName, usedFallback: false };
    }
  }

  const fallbackName = fallbackFiberNameMap.get(fiberId);
  if (typeof fallbackName === "string" && fallbackName.trim()) {
    return { name: fallbackName.trim(), usedFallback: false };
  }

  return {
    name: `${rootName}::Fiber#${fiberId}`,
    usedFallback: true,
  };
}

function buildCommitFlamegraph({
  rootID,
  commitTree,
  rootName,
  fallbackFiberNameMap,
  renderedFibers,
  actualByFiber,
  selfByFiber,
  reasonsByFiber,
  hookNameResolver,
  runtimeHookResolver,
  commitUpdaterIDs,
}) {
  const nodesByID = commitTree?.nodes ?? new Map();
  let rootFiberId = Number.isFinite(commitTree?.rootID) ? commitTree.rootID : null;

  if (!Number.isFinite(rootFiberId) || (!nodesByID.has(rootFiberId) && nodesByID.size > 0)) {
    rootFiberId = nodesByID.keys().next().value;
  }

  const includedFiberIDs = new Set();
  if (Number.isFinite(rootFiberId)) {
    includedFiberIDs.add(rootFiberId);
  }

  for (const fiberId of renderedFibers) {
    includedFiberIDs.add(fiberId);

    let cursor = fiberId;
    const seen = new Set([cursor]);
    while (true) {
      const node = nodesByID.get(cursor);
      if (!node) break;

      const parentID = Number(node.parentID);
      if (!Number.isFinite(parentID) || parentID === 0 || seen.has(parentID)) break;

      includedFiberIDs.add(parentID);
      seen.add(parentID);
      cursor = parentID;
    }
  }

  if (includedFiberIDs.size === 0 && nodesByID.size > 0) {
    includedFiberIDs.add(nodesByID.keys().next().value);
  }

  if (!Number.isFinite(rootFiberId) && includedFiberIDs.size > 0) {
    rootFiberId = includedFiberIDs.values().next().value;
  }

  const parentByFiberID = new Map();
  const childrenByFiberID = new Map();
  for (const fiberId of includedFiberIDs) {
    childrenByFiberID.set(fiberId, []);
  }

  for (const fiberId of includedFiberIDs) {
    const node = nodesByID.get(fiberId);
    let parentFiberId = 0;

    if (fiberId !== rootFiberId) {
      const parentCandidate = Number(node?.parentID);
      if (Number.isFinite(parentCandidate) && includedFiberIDs.has(parentCandidate)) {
        parentFiberId = parentCandidate;
      } else if (Number.isFinite(rootFiberId)) {
        parentFiberId = rootFiberId;
      }
    }

    parentByFiberID.set(fiberId, parentFiberId);
    if (parentFiberId !== 0) {
      const children = childrenByFiberID.get(parentFiberId) ?? [];
      if (!children.includes(fiberId)) {
        children.push(fiberId);
        childrenByFiberID.set(parentFiberId, children);
      }
    }
  }

  for (const fiberId of includedFiberIDs) {
    const node = nodesByID.get(fiberId);
    if (!node) continue;

    const knownChildren = childrenByFiberID.get(fiberId) ?? [];
    const orderedFromTree = node.children.filter((childID) => includedFiberIDs.has(childID));
    const orderedSet = new Set(orderedFromTree);
    const extras = knownChildren.filter((childID) => !orderedSet.has(childID)).sort((a, b) => a - b);
    childrenByFiberID.set(fiberId, orderedFromTree.concat(extras));
  }

  const depthByFiberID = new Map();
  if (Number.isFinite(rootFiberId) && includedFiberIDs.has(rootFiberId)) {
    const queue = [rootFiberId];
    depthByFiberID.set(rootFiberId, 0);

    while (queue.length > 0) {
      const parentID = queue.shift();
      const parentDepth = depthByFiberID.get(parentID) ?? 0;
      for (const childID of childrenByFiberID.get(parentID) ?? []) {
        if (depthByFiberID.has(childID)) continue;
        depthByFiberID.set(childID, parentDepth + 1);
        queue.push(childID);
      }
    }
  }

  for (const fiberId of includedFiberIDs) {
    if (!depthByFiberID.has(fiberId)) {
      depthByFiberID.set(fiberId, Number.isFinite(rootFiberId) && fiberId !== rootFiberId ? 1 : 0);
    }
  }

  const computedSubtreeMsByFiberID = new Map();
  const computeSubtreeMs = (fiberId, lineage = new Set()) => {
    if (computedSubtreeMsByFiberID.has(fiberId)) {
      return computedSubtreeMsByFiberID.get(fiberId);
    }
    if (lineage.has(fiberId)) {
      return Number(selfByFiber.get(fiberId) ?? 0);
    }

    lineage.add(fiberId);
    let total = Number(selfByFiber.get(fiberId) ?? 0);
    if (!Number.isFinite(total)) total = 0;

    for (const childID of childrenByFiberID.get(fiberId) ?? []) {
      total += computeSubtreeMs(childID, lineage);
    }

    lineage.delete(fiberId);
    computedSubtreeMsByFiberID.set(fiberId, total);
    return total;
  };

  for (const fiberId of includedFiberIDs) {
    computeSubtreeMs(fiberId);
  }

  const nodes = [...includedFiberIDs]
    .map((fiberId) => {
      const node = nodesByID.get(fiberId) ?? null;
      const nameMeta = resolveFiberName({
        fiberId,
        node,
        fallbackFiberNameMap,
        rootName,
      });
      const selfMs = Number(selfByFiber.get(fiberId) ?? 0);
      const subtreeMs = Number(actualByFiber.get(fiberId) ?? 0);
      const runtimeElementMeta = runtimeHookResolver
        ? runtimeHookResolver.getElementMeta({
            rootID,
            fiberID: fiberId,
          })
        : null;
      const whyRendered = parseRenderReasonDetails(reasonsByFiber.get(fiberId), {
        componentName: nameMeta.name,
        hookNameResolver,
        runtimeHookResolver,
        rootID,
        fiberID: fiberId,
        commitUpdaterIDs,
      });

      return {
        fiberId,
        parentFiberId: Number(parentByFiberID.get(fiberId) ?? 0),
        childrenFiberIds: childrenByFiberID.get(fiberId) ?? [],
        depth: Number(depthByFiberID.get(fiberId) ?? 0),
        name: nameMeta.name,
        key: node?.key ?? null,
        type: Number.isFinite(node?.type) ? Number(node.type) : null,
        hocDisplayNames: Array.isArray(node?.hocDisplayNames) ? node.hocDisplayNames : null,
        compiledWithForget: node?.compiledWithForget === true,
        didRender:
          renderedFibers.has(fiberId) ||
          Number.isFinite(selfMs) && selfMs > 0 ||
          Number.isFinite(subtreeMs) && subtreeMs > 0 ||
          whyRendered !== null,
        usedFallbackName: nameMeta.usedFallback,
        selfMs: round(Number.isFinite(selfMs) ? selfMs : 0),
        subtreeMs: round(Number.isFinite(subtreeMs) ? subtreeMs : 0),
        computedSubtreeMs: round(Number(computedSubtreeMsByFiberID.get(fiberId) ?? 0)),
        treeBaseDurationMs: round(Number(node?.treeBaseDuration ?? 0)),
        inspectedSource: runtimeElementMeta?.source ?? null,
        inspectedOwners: runtimeElementMeta?.owners ?? [],
        whyRendered,
      };
    })
    .sort((a, b) => {
      if (a.depth !== b.depth) return a.depth - b.depth;
      return a.fiberId - b.fiberId;
    });

  const nodeByFiberID = new Map(nodes.map((node) => [node.fiberId, node]));
  const renderedComponents = [...renderedFibers]
    .map((fiberId) => {
      const node = nodeByFiberID.get(fiberId);
      if (node) {
        return {
          fiberId: node.fiberId,
          name: node.name,
          usedFallbackName: node.usedFallbackName,
          selfMs: node.selfMs,
          subtreeMs: node.subtreeMs,
          computedSubtreeMs: node.computedSubtreeMs,
          whyRendered: node.whyRendered,
        };
      }

      const fallbackNameMeta = resolveFiberName({
        fiberId,
        node: null,
        fallbackFiberNameMap,
        rootName,
      });
      const selfMs = Number(selfByFiber.get(fiberId) ?? 0);
      const subtreeMs = Number(actualByFiber.get(fiberId) ?? 0);
      return {
        fiberId,
        name: fallbackNameMeta.name,
        usedFallbackName: fallbackNameMeta.usedFallback,
        selfMs: round(Number.isFinite(selfMs) ? selfMs : 0),
        subtreeMs: round(Number.isFinite(subtreeMs) ? subtreeMs : 0),
        computedSubtreeMs: round(Number.isFinite(selfMs) ? selfMs : 0),
        whyRendered: parseRenderReasonDetails(reasonsByFiber.get(fiberId), {
          componentName: fallbackNameMeta.name,
          hookNameResolver,
          runtimeHookResolver,
          rootID,
          fiberID: fiberId,
          commitUpdaterIDs,
        }),
      };
    })
    .sort((a, b) => {
      if (b.subtreeMs !== a.subtreeMs) return b.subtreeMs - a.subtreeMs;
      if (b.selfMs !== a.selfMs) return b.selfMs - a.selfMs;
      return a.name.localeCompare(b.name);
    });

  return {
    rootFiberId: Number.isFinite(rootFiberId) ? rootFiberId : null,
    totalNodesInCommitTree: nodesByID.size,
    includedNodeCount: nodes.length,
    renderedNodeCount: renderedComponents.length,
    includesAncestorsOnly: true,
    renderedNodeIds: renderedComponents.map((component) => component.fiberId),
    nodes,
    renderedComponents,
  };
}

function analyzeReactDevtoolsExport(inputPath, data, options = {}) {
  const roots = Array.isArray(data?.dataForRoots) ? data.dataForRoots : [];
  const hotspotMap = new Map();
  const commitDurationsMs = [];
  const commitTimestampsMs = [];
  const componentTimestampsByName = new Map();
  const renderReasonCounts = new Map();
  const commitFlamegraphs = [];
  const warningSet = new Set();
  const hookNameResolver = createHookNameResolver({
    sourceRoot: options.sourceRoot,
    enabled: options.enableHookNameEnrichment !== false,
    warningSet,
  });
  const runtimeHookResolver = createRuntimeHookResolver({
    profileData: data,
    warningSet,
  });
  let commitCount = 0;
  let componentRenderSamples = 0;
  let unnamedFiberRenders = 0;
  let commitsWithRenderReasons = 0;
  let commitsWithoutRenderReasons = 0;
  let knownRenderReasonSamples = 0;
  let unknownRenderReasonSamples = 0;
  let unknownRenderReasonUpdaterMatches = 0;

  for (const root of roots) {
    const rootName = typeof root?.displayName === "string" && root.displayName.trim()
      ? root.displayName.trim()
      : "root";
    const fallbackFiberNameMap = buildFiberNameMap(root, rootName);
    const commitTree = buildInitialCommitTree(root);
    const operationsByCommit = Array.isArray(root?.operations) ? root.operations : [];

    const commits = Array.isArray(root?.commitData) ? root.commitData : [];
    for (let commitIndex = 0; commitIndex < commits.length; commitIndex++) {
      const commit = commits[commitIndex];
      if (commit && typeof commit === "object" && !Array.isArray(commit)) {
        if (Array.isArray(operationsByCommit[commitIndex])) {
          applyOperationsToCommitTree(commitTree, operationsByCommit[commitIndex], warningSet);
        }

        commitCount += 1;

        let durationMs = pickNumber(commit, ["duration", "actualDuration", "commitDuration"]);
        if (!Number.isFinite(durationMs)) {
          const fiberSelfTotal = normalizePairEntries(commit.fiberSelfDurations).reduce(
            (sum, pair) => sum + (Number.isFinite(pair[1]) ? pair[1] : 0),
            0,
          );
          if (fiberSelfTotal > 0) {
            durationMs = fiberSelfTotal;
          } else {
            const fiberActual = sumNumericArray(commit.fiberActualDurations);
            if (fiberActual > 0) {
              durationMs = fiberActual;
            }
          }
        }
        if (Number.isFinite(durationMs) && durationMs > 0) {
          commitDurationsMs.push(durationMs);
        }

        const ts = pickNumber(commit, ["timestamp", "commitTime", "startTime"]);
        const commitTimestampMs = Number.isFinite(ts) ? ts : commitIndex;
        if (Number.isFinite(commitTimestampMs)) {
          commitTimestampsMs.push(commitTimestampMs);
        }

        const actualByFiber = toPairMap(commit.fiberActualDurations);
        const selfByFiber = toPairMap(commit.fiberSelfDurations);
        const reasonsByFiber = toPairMap(commit.changeDescriptions);
        const renderedFibers = new Set([...actualByFiber.keys(), ...selfByFiber.keys(), ...reasonsByFiber.keys()]);
        const normalizedUpdaters = Array.isArray(commit?.updaters)
          ? commit.updaters.map(normalizeUpdater).filter(Boolean)
          : [];
        const commitUpdaterIDs = new Set(
          normalizedUpdaters
            .map((updater) => updater?.id)
            .filter((id) => Number.isFinite(id))
            .map((id) => Number(id)),
        );

        if (reasonsByFiber.size > 0) {
          commitsWithRenderReasons += 1;
        } else {
          commitsWithoutRenderReasons += 1;
        }

        const flamegraph = buildCommitFlamegraph({
          rootID: commitTree.rootID,
          commitTree,
          rootName,
          fallbackFiberNameMap,
          renderedFibers,
          actualByFiber,
          selfByFiber,
          reasonsByFiber,
          hookNameResolver,
          runtimeHookResolver,
          commitUpdaterIDs,
        });

        commitFlamegraphs.push({
          rootID: commitTree.rootID,
          rootName,
          commitIndex,
          timestampMs: round(Number.isFinite(commitTimestampMs) ? commitTimestampMs : commitIndex),
          durationMs: round(Number.isFinite(durationMs) ? durationMs : 0),
          effectDurationMs: Number.isFinite(commit?.effectDuration) ? round(commit.effectDuration) : null,
          passiveEffectDurationMs: Number.isFinite(commit?.passiveEffectDuration)
            ? round(commit.passiveEffectDuration)
            : null,
          priorityLevel: typeof commit?.priorityLevel === "string" ? commit.priorityLevel : null,
          renderedComponentCount: flamegraph.renderedNodeCount,
          flamegraph,
          rankedBySelfMs: flamegraph.renderedComponents
            .slice()
            .sort((a, b) => {
              if (b.selfMs !== a.selfMs) return b.selfMs - a.selfMs;
              if (b.subtreeMs !== a.subtreeMs) return b.subtreeMs - a.subtreeMs;
              return a.name.localeCompare(b.name);
            }),
          updaters: normalizedUpdaters,
        });

        for (const renderedComponent of flamegraph.renderedComponents) {
          const fiberId = renderedComponent.fiberId;
          const subtreeMs = Number(renderedComponent.subtreeMs ?? 0);
          const selfMs = Number(renderedComponent.selfMs ?? 0);
          const primaryMs = selfMs > 0 ? selfMs : subtreeMs;

          // Keep count signals even if timing is zero, but ignore obviously invalid entries.
          if (!Number.isFinite(primaryMs) && !Number.isFinite(subtreeMs) && !Number.isFinite(selfMs)) {
            continue;
          }

          const name = renderedComponent.name;
          if (renderedComponent.usedFallbackName) {
            unnamedFiberRenders += 1;
          }

          componentRenderSamples += 1;
          const reasonSummary = renderedComponent.whyRendered?.summary ?? null;
          if (reasonSummary) {
            renderReasonCounts.set(reasonSummary, (renderReasonCounts.get(reasonSummary) ?? 0) + 1);
            if (reasonSummary === "unknown") {
              unknownRenderReasonSamples += 1;
              if (renderedComponent.whyRendered?.inferredReason?.kind === "updater-match") {
                unknownRenderReasonUpdaterMatches += 1;
              }
            } else {
              knownRenderReasonSamples += 1;
            }
          }

          const aggregate = hotspotMap.get(name) ?? {
            name,
            count: 0,
            totalMs: 0,
            totalSelfMs: 0,
            totalSubtreeMs: 0,
            maxSelfMs: 0,
            maxSubtreeMs: 0,
            reasonCounts: new Map(),
          };

          aggregate.count += 1;
          aggregate.totalMs += Number.isFinite(primaryMs) ? primaryMs : 0;
          aggregate.totalSelfMs += Number.isFinite(selfMs) ? selfMs : 0;
          aggregate.totalSubtreeMs += Number.isFinite(subtreeMs) ? subtreeMs : 0;
          aggregate.maxSelfMs = Math.max(aggregate.maxSelfMs, Number.isFinite(selfMs) ? selfMs : 0);
          aggregate.maxSubtreeMs = Math.max(
            aggregate.maxSubtreeMs,
            Number.isFinite(subtreeMs) ? subtreeMs : 0,
          );

          if (reasonSummary) {
            aggregate.reasonCounts.set(reasonSummary, (aggregate.reasonCounts.get(reasonSummary) ?? 0) + 1);
          }

          hotspotMap.set(name, aggregate);

          const timestamps = componentTimestampsByName.get(name) ?? [];
          timestamps.push(commitTimestampMs);
          componentTimestampsByName.set(name, timestamps);
        }
      }
    }
  }

  const totalReactTimeMs = commitDurationsMs.length
    ? commitDurationsMs.reduce((sum, value) => sum + value, 0)
    : [...hotspotMap.values()].reduce((sum, item) => sum + item.totalMs, 0);

  const topComponentCounts = [...componentTimestampsByName.entries()]
    .map(([name, ts]) => ({ name, count: ts.length }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 25);

  const topComponentCadence = [...componentTimestampsByName.entries()]
    .map(([name, ts]) => ({ name, count: ts.length, cadence: summarizeCadence(ts) }))
    .filter((item) => item.cadence.samples >= 4)
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)
    .map((item) => ({
      name: item.name,
      count: item.count,
      medianDeltaMs: item.cadence.medianDeltaMs,
      regularity: item.cadence.regularity,
      likelyIntervalChurn: item.cadence.likelyIntervalChurn,
    }));

  const topRenderReasons = [...renderReasonCounts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);

  const cadence = summarizeCadence(commitTimestampsMs);
  if (!cadence.samples && topComponentCadence.length > 0) {
    const fallback =
      topComponentCadence.find((item) => item.likelyIntervalChurn) ??
      topComponentCadence.find((item) => Number.isFinite(item.medianDeltaMs) && item.medianDeltaMs >= 100) ??
      topComponentCadence[0];
    cadence.samples = fallback.count;
    cadence.medianDeltaMs = fallback.medianDeltaMs;
    cadence.regularity = fallback.regularity;
    cadence.likelyIntervalChurn = fallback.likelyIntervalChurn;
  }

  const hotspots = [...hotspotMap.values()]
    .map((h) => ({
      name: h.name,
      count: h.count,
      totalMs: round(h.totalMs),
      avgMs: round(h.totalMs / Math.max(1, h.count)),
      selfMs: round(h.totalSelfMs),
      avgSelfMs: round(h.totalSelfMs / Math.max(1, h.count)),
      subtreeMs: round(h.totalSubtreeMs),
      avgSubtreeMs: round(h.totalSubtreeMs / Math.max(1, h.count)),
      topReasons: [...h.reasonCounts.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 3),
    }))
    .sort((a, b) => {
      if (b.totalMs !== a.totalMs) return b.totalMs - a.totalMs;
      return b.count - a.count;
    })
    .slice(0, 25);

  const renderReasonSampleCount = knownRenderReasonSamples + unknownRenderReasonSamples;
  const unknownRenderReasonRate =
    renderReasonSampleCount > 0 ? unknownRenderReasonSamples / renderReasonSampleCount : null;
  const runtimeHookStats = runtimeHookResolver.getStats();
  const hookNameStats = hookNameResolver.getStats();

  return {
    source: path.resolve(inputPath),
    mode: "react-devtools-export",
    generatedAt: new Date().toISOString(),
    enrichment: {
      hookNames: hookNameStats,
      runtimeInspect: runtimeHookStats,
      renderReasons: {
        knownSamples: knownRenderReasonSamples,
        unknownSamples: unknownRenderReasonSamples,
        sampleCount: renderReasonSampleCount,
        unknownRate: unknownRenderReasonRate === null ? null : round(unknownRenderReasonRate, 3),
        unknownWithUpdaterMatch: unknownRenderReasonUpdaterMatches,
      },
    },
    totals: {
      reactEvents: componentRenderSamples || commitCount,
      reactDurationEvents: componentRenderSamples,
      reactComponentTrackEvents: componentRenderSamples,
      reactSchedulerTrackEvents: 0,
      reactTimeMs: round(totalReactTimeMs),
      commits: commitCount || commitDurationsMs.length,
      avgCommitMs: round(median(commitDurationsMs) ?? 0),
      p95CommitMs: round(percentile(commitDurationsMs, 95) ?? 0),
    },
    cadence,
    reactTracks: {
      componentsTrackDetected: componentRenderSamples > 0,
      topComponentCounts,
      topComponentCadence,
      schedulerTrackDetected: false,
      topSchedulerLanes: [],
      topSchedulerPhases: [],
      topRenderReasons,
    },
    uiParity: {
      source: "react-devtools-frontend",
      includes: [
        "commit-selector-metadata",
        "commit-sidebar-updaters",
        "flamegraph-like-tree",
        "ranked-self-duration-list",
        "why-did-this-render-change-descriptions",
        "inspected-element-source-location",
        "inspected-element-owners",
        "runtime-hook-slot-enrichment-from-inspectElement",
        "parse-hook-names-source-map-pipeline",
        "best-effort-hook-label-enrichment-from-source",
      ],
      missing: [
        "hook-name parsing can still degrade when runtime source URLs are not fetchable or source-map source content is unavailable",
      ],
    },
    commits: commitFlamegraphs,
    warnings: [
      ...(unnamedFiberRenders > 0
        ? [
            `Some rendered fibers (${unnamedFiberRenders}) could not be mapped to display names; they are reported as <root>::Fiber#<id>.`,
          ]
        : []),
      ...(commitCount > 0 && commitsWithRenderReasons === 0
        ? [
            "No render reason details were present in the export. In React DevTools, enable 'Record why each component rendered' before profiling.",
          ]
        : []),
      ...(commitsWithoutRenderReasons > 0 && commitsWithRenderReasons > 0
        ? [
            `Render reason details were missing for ${commitsWithoutRenderReasons} commit(s); before/after reason comparisons are partially incomplete.`,
          ]
        : []),
      ...(hookNameStats.enabled &&
      hookNameStats.resolvedHookSlots === 0 &&
      runtimeHookStats.resolvedHookSlots === 0
        ? [
            "Hook name enrichment did not resolve source hook labels. This usually means component source was not discoverable from the selected source root.",
          ]
        : []),
      ...(runtimeHookStats.enabled && runtimeHookStats.elementsScanned === 0
        ? [
            "Runtime inspectElement enrichment was enabled but no inspected element payloads were found in this export.",
          ]
        : []),
      ...(runtimeHookStats?.hookNameParsing?.enabled &&
      runtimeHookStats.hookNameParsing.unresolvedLocationCount > 0
        ? [
            `parseHookNames left ${runtimeHookStats.hookNameParsing.unresolvedLocationCount} unresolved hook source location(s); inspect enrichment.runtimeInspect.hookNameParsing.unresolvedElementDiagnostics for per-fiber details.`,
          ]
        : []),
      ...(unknownRenderReasonRate !== null && unknownRenderReasonRate >= 0.5
        ? [
            "Most whyRendered entries are 'unknown'. This is a React export limitation; use commit updaters, hooksChangedDetails, and before/after commit timing/component membership deltas for triage.",
          ]
        : []),
      ...(unknownRenderReasonUpdaterMatches > 0
        ? [
            `${unknownRenderReasonUpdaterMatches} unknown whyRendered sample(s) matched commit updater fibers; these are tagged with inferredReason.kind='updater-match' (low confidence).`,
          ]
        : []),
      ...[...warningSet.values()],
    ],
    hotspots,
  };
}

function toSummary(report) {
  const lines = [];
  lines.push(`Mode: ${report.mode}`);
  lines.push(`Source: ${report.source}`);
  lines.push(`React time: ${report.totals.reactTimeMs}ms`);
  lines.push(`React events/commits: ${report.totals.reactEvents}`);
  lines.push(`Median commit: ${report.totals.avgCommitMs}ms | P95 commit: ${report.totals.p95CommitMs}ms`);

  if (Number.isFinite(report?.totals?.reactComponentTrackEvents)) {
    lines.push(`React component track events: ${report.totals.reactComponentTrackEvents}`);
  }
  if (Number.isFinite(report?.totals?.reactSchedulerTrackEvents)) {
    lines.push(`React scheduler track events: ${report.totals.reactSchedulerTrackEvents}`);
  }

  if (report.cadence?.samples) {
    lines.push(
      `Cadence: median ${report.cadence.medianDeltaMs}ms, regularity ${report.cadence.regularity}, interval-churn ${report.cadence.likelyIntervalChurn ? "likely" : "not-detected"}`,
    );
  }

  if (Array.isArray(report?.reactTracks?.topComponentCounts) && report.reactTracks.topComponentCounts.length) {
    lines.push("Top component track counts:");
    for (const component of report.reactTracks.topComponentCounts.slice(0, 5)) {
      lines.push(`- ${component.name}: ${component.count}`);
    }
  }

  if (Array.isArray(report?.reactTracks?.topSchedulerLanes) && report.reactTracks.topSchedulerLanes.length) {
    lines.push("Top scheduler lanes:");
    for (const lane of report.reactTracks.topSchedulerLanes.slice(0, 5)) {
      lines.push(`- ${lane.lane}: ${lane.count}`);
    }
  }

  if (Array.isArray(report?.reactTracks?.topRenderReasons) && report.reactTracks.topRenderReasons.length) {
    lines.push("Top render reasons:");
    for (const reason of report.reactTracks.topRenderReasons.slice(0, 5)) {
      lines.push(`- ${reason.reason}: ${reason.count}`);
    }
  }

  if (Array.isArray(report?.commits) && report.commits.length > 0) {
    lines.push(`Commit flamegraphs: ${report.commits.length}`);
  }

  const hookEnrichment = report?.enrichment?.hookNames;
  if (hookEnrichment?.enabled) {
    lines.push(
      `Hook label enrichment: resolved ${hookEnrichment.resolvedHookSlots}/${hookEnrichment.resolvedHookSlots + hookEnrichment.unresolvedHookSlots} changed hook slots`,
    );
  }
  const runtimeEnrichment = report?.enrichment?.runtimeInspect;
  if (runtimeEnrichment?.enabled) {
    lines.push(
      `Runtime inspect enrichment: scanned ${runtimeEnrichment.elementsScanned} elements, resolved ${runtimeEnrichment.resolvedHookSlots}/${runtimeEnrichment.resolvedHookSlots + runtimeEnrichment.unresolvedHookSlots} changed hook slots`,
    );
    const parseStats = runtimeEnrichment?.hookNameParsing;
    if (parseStats?.enabled) {
      lines.push(
        `Runtime parseHookNames: unresolved locations ${parseStats.unresolvedLocationCount}, unresolved elements ${parseStats.elementsWithUnresolvedLocations}`,
      );
    }
  }

  const renderReasonEnrichment = report?.enrichment?.renderReasons;
  if (Number.isFinite(renderReasonEnrichment?.sampleCount) && renderReasonEnrichment.sampleCount > 0) {
    lines.push(
      `Render-reason coverage: known ${renderReasonEnrichment.knownSamples}/${renderReasonEnrichment.sampleCount}, unknown ${renderReasonEnrichment.unknownSamples}/${renderReasonEnrichment.sampleCount}`,
    );
  }

  lines.push("Top hotspots:");
  for (const hotspot of report.hotspots.slice(0, 10)) {
    lines.push(`- ${hotspot.name}: total ${hotspot.totalMs}ms, count ${hotspot.count}, avg ${hotspot.avgMs}ms`);
  }
  return lines.join("\n");
}

function hasDirectory(targetPath) {
  try {
    return fs.statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function inferSourceRootFromInput(inputPath) {
  const resolvedInput = path.resolve(inputPath);
  let cursor = path.dirname(resolvedInput);
  const maxHops = 8;

  for (let hop = 0; hop < maxHops; hop += 1) {
    if (hasDirectory(path.join(cursor, "src"))) {
      return cursor;
    }

    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  return process.cwd();
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (error) {
    console.error(String(error.message));
    console.error(usage());
    process.exit(1);
  }

  if (args.help || !args.input) {
    console.log(usage());
    process.exit(args.help ? 0 : 1);
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(args.input, "utf8"));
  } catch (error) {
    console.error(`Failed to read JSON input: ${error.message}`);
    process.exit(1);
  }

  let report;
  if (Array.isArray(data?.traceEvents) || Array.isArray(data)) {
    report = analyzeChromeTrace(args.input, data);
  } else if (Array.isArray(data?.dataForRoots)) {
    const sourceRoot = args.sourceRoot ? path.resolve(args.sourceRoot) : inferSourceRootFromInput(args.input);
    report = analyzeReactDevtoolsExport(args.input, data, {
      sourceRoot,
      enableHookNameEnrichment: args.enableHookNameEnrichment !== false,
    });
  } else {
    console.error("Unsupported profile format. Expected traceEvents[] or dataForRoots[].");
    process.exit(1);
  }

  const outputText = JSON.stringify(report, null, 2);
  if (args.output) {
    fs.writeFileSync(args.output, outputText);
    console.log(`Wrote report: ${path.resolve(args.output)}`);
  } else {
    console.log(outputText);
  }

  console.error("\n" + toSummary(report));
}

main();
