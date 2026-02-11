#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--before" || token === "-b") {
      args.before = argv[++i];
      continue;
    }
    if (token === "--after" || token === "-a") {
      args.after = argv[++i];
      continue;
    }
    if (token === "--output" || token === "-o") {
      args.output = argv[++i];
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
    "  node scripts/compare-profiles.mjs --before <baseline-report.json> --after <optimized-report.json> [--output <diff.json>]",
  ].join("\n");
}

function round(num, digits = 2) {
  if (!Number.isFinite(num)) return 0;
  const factor = 10 ** digits;
  return Math.round(num * factor) / factor;
}

function pctDelta(before, after) {
  if (!Number.isFinite(before) || before === 0) return 0;
  return ((after - before) / before) * 100;
}

function hotspotMap(report) {
  const map = new Map();
  for (const hotspot of report.hotspots ?? []) {
    map.set(hotspot.name, hotspot);
  }
  return map;
}

function compareReports(before, after) {
  const beforeReactTime = Number(before?.totals?.reactTimeMs ?? 0);
  const afterReactTime = Number(after?.totals?.reactTimeMs ?? 0);
  const beforeCommits = Number(before?.totals?.commits ?? 0);
  const afterCommits = Number(after?.totals?.commits ?? 0);
  const beforeComponentTrackEvents = Number(before?.totals?.reactComponentTrackEvents ?? 0);
  const afterComponentTrackEvents = Number(after?.totals?.reactComponentTrackEvents ?? 0);
  const beforeSchedulerTrackEvents = Number(before?.totals?.reactSchedulerTrackEvents ?? 0);
  const afterSchedulerTrackEvents = Number(after?.totals?.reactSchedulerTrackEvents ?? 0);

  const beforeMap = hotspotMap(before);
  const afterMap = hotspotMap(after);

  const names = new Set([...beforeMap.keys(), ...afterMap.keys()]);
  const hotspotDiffs = [];
  for (const name of names) {
    const b = beforeMap.get(name) ?? { totalMs: 0, count: 0 };
    const a = afterMap.get(name) ?? { totalMs: 0, count: 0 };
    hotspotDiffs.push({
      name,
      beforeTotalMs: round(Number(b.totalMs ?? 0)),
      afterTotalMs: round(Number(a.totalMs ?? 0)),
      deltaMs: round(Number(a.totalMs ?? 0) - Number(b.totalMs ?? 0)),
      deltaPct: round(pctDelta(Number(b.totalMs ?? 0), Number(a.totalMs ?? 0))),
      beforeCount: Number(b.count ?? 0),
      afterCount: Number(a.count ?? 0),
      countDelta: Number(a.count ?? 0) - Number(b.count ?? 0),
    });
  }

  const cadenceBefore = before?.cadence?.likelyIntervalChurn === true;
  const cadenceAfter = after?.cadence?.likelyIntervalChurn === true;
  const hasDurationSignal = beforeReactTime > 0 || afterReactTime > 0;
  const beforePrimary = hasDurationSignal ? beforeReactTime : beforeComponentTrackEvents;
  const afterPrimary = hasDurationSignal ? afterReactTime : afterComponentTrackEvents;
  const primaryImproved = afterPrimary < beforePrimary;
  const primaryRegressed = afterPrimary > beforePrimary;
  const cadenceImproved = !cadenceBefore || (cadenceBefore && !cadenceAfter);
  const cadenceRegressed = !cadenceBefore && cadenceAfter;

  const verdict =
    primaryImproved && cadenceImproved
      ? "improved"
      : primaryRegressed || cadenceRegressed
        ? "regressed"
        : "mixed";

  const topImprovements = hasDurationSignal
    ? [...hotspotDiffs]
        .filter((d) => d.deltaMs < 0)
        .sort((a, b) => a.deltaMs - b.deltaMs)
        .slice(0, 10)
    : [...hotspotDiffs]
        .filter((d) => d.countDelta < 0)
        .sort((a, b) => a.countDelta - b.countDelta)
        .slice(0, 10);

  const topRegressions = hasDurationSignal
    ? [...hotspotDiffs]
        .filter((d) => d.deltaMs > 0)
        .sort((a, b) => b.deltaMs - a.deltaMs)
        .slice(0, 10)
    : [...hotspotDiffs]
        .filter((d) => d.countDelta > 0)
        .sort((a, b) => b.countDelta - a.countDelta)
        .slice(0, 10);

  return {
    comparedAt: new Date().toISOString(),
    before: {
      source: before.source,
      mode: before.mode,
      reactTimeMs: round(beforeReactTime),
      commits: beforeCommits,
      componentTrackEvents: beforeComponentTrackEvents,
      schedulerTrackEvents: beforeSchedulerTrackEvents,
      intervalChurnLikely: cadenceBefore,
    },
    after: {
      source: after.source,
      mode: after.mode,
      reactTimeMs: round(afterReactTime),
      commits: afterCommits,
      componentTrackEvents: afterComponentTrackEvents,
      schedulerTrackEvents: afterSchedulerTrackEvents,
      intervalChurnLikely: cadenceAfter,
    },
    deltas: {
      reactTimeMs: round(afterReactTime - beforeReactTime),
      reactTimePct: round(pctDelta(beforeReactTime, afterReactTime)),
      commits: afterCommits - beforeCommits,
      commitsPct: round(pctDelta(beforeCommits, afterCommits)),
      componentTrackEvents: afterComponentTrackEvents - beforeComponentTrackEvents,
      componentTrackEventsPct: round(pctDelta(beforeComponentTrackEvents, afterComponentTrackEvents)),
      schedulerTrackEvents: afterSchedulerTrackEvents - beforeSchedulerTrackEvents,
      schedulerTrackEventsPct: round(pctDelta(beforeSchedulerTrackEvents, afterSchedulerTrackEvents)),
    },
    comparedUsing: hasDurationSignal ? "react-time-ms" : "component-track-events",
    hotspotRanking: hasDurationSignal ? "delta-ms" : "count-delta",
    topImprovements,
    topRegressions,
    verdict,
  };
}

function toSummary(result) {
  const lines = [];
  lines.push(`Verdict: ${result.verdict}`);
  lines.push(
    `React time: ${result.before.reactTimeMs}ms -> ${result.after.reactTimeMs}ms (${result.deltas.reactTimeMs}ms, ${result.deltas.reactTimePct}%)`,
  );
  lines.push(
    `Commits: ${result.before.commits} -> ${result.after.commits} (${result.deltas.commits}, ${result.deltas.commitsPct}%)`,
  );
  lines.push(
    `Component track events: ${result.before.componentTrackEvents} -> ${result.after.componentTrackEvents} (${result.deltas.componentTrackEvents}, ${result.deltas.componentTrackEventsPct}%)`,
  );
  lines.push(
    `Scheduler track events: ${result.before.schedulerTrackEvents} -> ${result.after.schedulerTrackEvents} (${result.deltas.schedulerTrackEvents}, ${result.deltas.schedulerTrackEventsPct}%)`,
  );
  lines.push(`Compared using: ${result.comparedUsing}`);
  lines.push(`Hotspot ranking: ${result.hotspotRanking}`);
  lines.push(
    `Interval churn: before=${result.before.intervalChurnLikely} after=${result.after.intervalChurnLikely}`,
  );

  if (result.topImprovements.length) {
    lines.push("Top improvements:");
    for (const item of result.topImprovements.slice(0, 5)) {
      if (result.comparedUsing === "react-time-ms") {
        lines.push(`- ${item.name}: ${item.deltaMs}ms (${item.deltaPct}%)`);
      } else {
        lines.push(`- ${item.name}: count ${item.beforeCount} -> ${item.afterCount} (${item.countDelta})`);
      }
    }
  }

  if (result.topRegressions.length) {
    lines.push("Top regressions:");
    for (const item of result.topRegressions.slice(0, 5)) {
      if (result.comparedUsing === "react-time-ms") {
        lines.push(`- ${item.name}: +${item.deltaMs}ms (${item.deltaPct}%)`);
      } else {
        lines.push(`- ${item.name}: count ${item.beforeCount} -> ${item.afterCount} (+${item.countDelta})`);
      }
    }
  }

  return lines.join("\n");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
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

  if (args.help || !args.before || !args.after) {
    console.log(usage());
    process.exit(args.help ? 0 : 1);
  }

  let before;
  let after;
  try {
    before = readJson(args.before);
    after = readJson(args.after);
  } catch (error) {
    console.error(`Failed to read report JSON: ${error.message}`);
    process.exit(1);
  }

  const result = compareReports(before, after);
  const text = JSON.stringify(result, null, 2);

  if (args.output) {
    fs.writeFileSync(args.output, text);
    console.log(`Wrote diff report: ${path.resolve(args.output)}`);
  } else {
    console.log(text);
  }

  console.error("\n" + toSummary(result));
}

main();
