# react-profiler-mcp

React profiler automation toolkit for autonomous perf verification workflows.

## Current Scope

This project currently implements:

- MCP wrappers around the `react-profiler-optimize` skill scripts.
- `analyze-profile.mjs` execution for Chrome trace or React DevTools export inputs.
- `compare-profiles.mjs` execution for before/after report diffs.
- Automated React DevTools profile capture (`record -> stop -> export`) from a live app URL.
- Runtime `inspectElement` enrichment capture during export for frontend-like hook/source/owner context.

## Recorder Architecture

The React recorder uses the same bridge dataflow React DevTools uses internally:

1. Inject `react-devtools-core/backend` into the target page at document start.
2. Connect backend to a local WebSocket bridge server.
3. Send frontend bridge events:
   - `startProfiling`
   - `stopProfiling`
   - `getProfilingData`
4. Capture `operations` during profiling to reconstruct snapshots/commit trees.
5. Merge backend profiling payload (`commitData`, durations, priorities, updaters) with frontend tree data (`operations`, `snapshots`) and export React DevTools profile JSON (`version: 5`).
6. Optionally call `inspectElement` for rendered fibers and store enrichment under `automationMeta.inspectedElements`.

## Workflow

1. Capture baseline profile JSON from app flow.
2. Analyze baseline profile via skill script.
3. Implement targeted fix.
4. Capture optimized profile JSON from same deterministic flow.
5. Compare baseline vs optimized via skill script.

## CLI

Run from `tools/react-profiler-mcp`:

```bash
node packages/cli/bin/react-profiler-cli.js record-react-devtools --url http://localhost:3000 --out profiles/baseline.json --wait-for-selector '#search-box' --duration-ms 9000 --record-change-descriptions true --inspect-elements true --inspect-elements-max 1500 --inspect-elements-timeout-ms 4000 --inspect-elements-concurrency 8 --parse-hook-names true --parse-hook-names-timeout-ms 5000 --parse-hook-names-source-root .
node packages/cli/bin/react-profiler-cli.js analyze --input profiles/baseline.json --out reports/baseline-report.json --source-root .
node packages/cli/bin/react-profiler-cli.js compare-profiles --before-profile profiles/baseline.json --after-profile profiles/optimized.json --out reports/compare.json
node packages/cli/bin/react-profiler-cli.js compare-reports --before-report reports/baseline-report.json --after-report reports/optimized-report.json --out reports/compare.json
```

Default-on recorder conditionals:

- `recordChangeDescriptions: true`
- `inspectElements: true`
- `parseHookNames: true`

Enterprise-oriented recorder defaults:

- `inspectElementsMaxPerRoot: 1500`
- `inspectElementsTimeoutMs: 4000`
- `inspectElementsConcurrency: 8`
- `parseHookNamesTimeoutMs: 5000`

## MCP Tools

`packages/mcp-server/index.js` exposes:

- `record_react_devtools_profile`
- `analyze_profile`
- `compare_profile_reports`
- `compare_profiles_end_to_end`

## Output Philosophy

For React DevTools exports (including recorder output), the analyzer prioritizes UI-parity commit structures:

- `commits[*]` with commit metadata (timestamp/durations/priority/updaters).
- `commits[*].flamegraph.nodes[*]` for tree + timing + why-rendered details.
- `commits[*].rankedBySelfMs[*]` for ranked view parity.

Aggregate sections (for example `hotspots`, top-* counts, cadence) are secondary convenience indexes.

Hook-change enrichment:

- Analyzer keeps exported hook indices as canonical data.
- Recorder runs vendored React DevTools `parseHookNames` logic during export capture when hook trees are available.
- Parsed hook names are written to `automationMeta.inspectedElements.roots[*].elements[*].hookNamesBySourceLocation`.
- Analyzer adds `hooksChangedDetails[]` from runtime `inspectElement` hook slots when available.
- Analyzer falls back to source-derived best-effort labels when runtime inspect data is missing.

## Frontend Enrichment Goal

Goal: CLI/MCP exports should retain all major profiler context the React DevTools frontend relies on, with clear fallbacks when parity is not possible.

Implementation note:

- The `parseHookNames` port is vendored in `packages/core/src/vendor/react-devtools-shared/hooks` with upstream pointers in `packages/core/src/vendor/react-devtools-shared/UPSTREAM.md`.

Vendoring policy:

- Keep all copied upstream code under `packages/core/src/vendor/<upstream-subtree>`.
- Keep upstream provenance in `UPSTREAM.md` next to vendored files.
- Keep local integration adapters outside the vendor tree (for example in `packages/core/src/hook-source-fetcher.js`).
- Prefer minimal, documented deviations so upstream re-syncs stay low-risk.

Implemented enrichments:

1. Commit-level metadata parity:
   - `timestampMs`, `durationMs`, `effectDurationMs`, `passiveEffectDurationMs`, `priorityLevel`.
2. Commit update attribution parity:
   - `updaters[]` per commit.
3. Flamegraph tree parity:
   - commit tree reconstruction from `snapshots + operations`,
   - per-node `selfMs`, `subtreeMs`, `computedSubtreeMs`, `treeBaseDurationMs`.
4. Why-rendered parity:
   - `props/state/context/hooks` change descriptions with per-commit component linkage.
5. Runtime inspect parity (new):
   - inspected component source location,
   - owner chain,
   - hook slots (index, primitive hook label, hook source location).
6. `parseHookNames` parity (new):
   - source-map aware custom hook variable-name parsing (React hook-map metadata + AST fallback).
7. Source fallback enrichment:
   - hook index to primitive hook label mapping from source scanning when runtime inspect data is unavailable.
8. parseHookNames diagnostics:
   - global parse totals (`requested/parsed/resolved/touched/timedOut/failed`) at `automationMeta.inspectedElements.hookNameParsing`.
   - per-element diagnostics (`resolved/unresolved locations`, fetch resolver counts, unresolved location keys) at `automationMeta.inspectedElements.roots[*].elements[*].hookNameParsing`.
9. Why-rendered limitation diagnostics:
   - analyzer reports render-reason coverage and warns when `whyRendered: "unknown"` dominates.
   - analyzer adds low-confidence `inferredReason.kind = "updater-match"` when an unknown sample matches commit updaters.

Current known gap:

- Hook-name parsing still depends on source discoverability/fetchability (e.g. inaccessible runtime URLs or missing source-map source content).
- `whyRendered` can remain `unknown` even with change descriptions enabled; this is a React export limitation. Use commit updaters + hook change details + before/after commit timing/component membership as fallback evidence.
