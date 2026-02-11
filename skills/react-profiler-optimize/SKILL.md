---
name: react-profiler-optimize
description: Profile React rendering performance, identify rerender hotspots, apply targeted fixes, and validate before/after improvements. Use when optimizing React apps with Chrome DevTools MCP performance traces or React DevTools Profiler exports, especially for context-wide rerenders, broken memoization dependencies, and missing React.memo boundaries.
---

# React Profiler Optimize

## Overview

Run an evidence-first React performance workflow:

1. Capture baseline profile data.
2. Rank hotspots by total render cost and render frequency.
3. Apply small, targeted fixes.
4. Re-profile the same flows.
5. Confirm measurable improvement and summarize deltas.

Prefer Chrome DevTools MCP traces for repeatable automation. Use React DevTools Profiler export when MCP is unavailable.
For React >= 19.2, treat React component track events in Chrome traces (`Components ⚛`) as first-class evidence for rerender frequency and cadence.
React DevTools Profiler exports are normalized into an analogous component-level report (`count`, cadence, hotspot timing, render-reason summaries) via `scripts/analyze-profile.mjs`.
React DevTools exports also include normalized `commits[]` flamegraph data for commit-by-commit analysis (`N`, `N+1`, `N+2`, etc).
When available, prefer runtime `inspectElement` enrichment from recorder output for hook/source/owner context (`automationMeta.inspectedElements`), then fall back to source scanning.
Use commit-level structures as primary evidence; treat aggregated rankings as secondary navigation aids.
Recorder defaults are intentionally default-on for attribution (`recordChangeDescriptions`, `inspectElements`, `parseHookNames`).

## Use This Skill With

- `scripts/analyze-profile.mjs` to convert a trace/profile JSON file into a normalized hotspot report.
- `scripts/compare-profiles.mjs` to compare baseline vs optimized reports.
- `react-profiler-mcp` recorder (`record-react-devtools` CLI / `record_react_devtools_profile` MCP tool) to automate React DevTools `record -> stop -> export` for deterministic flows.
- `references/footguns.md` for common high-value rerender footguns.
- `references/mcp-profiling.md` for the MCP interaction flow.
- `references/report-template.md` for a consistent optimization report format.

## Inputs To Collect First

Collect these before making changes:

- App path and start command.
- Exact user flows to profile (route, click path, typed inputs).
- Profiling source:
  - Chrome DevTools MCP trace JSON, or
  - React DevTools Profiler export JSON.
- Constraints:
  - No behavior changes.
  - No visual regressions.
  - Max allowed code surface touched.
  - Source-map policy for profiling environment (dev-first; production source maps must stay default-off unless explicitly approved for isolated profiling envs).

## Workflow

### 1) Capture Baseline

- Start app in development mode.
- Record one baseline trace/profile for each target flow.
- Keep interaction steps deterministic (same sequence and timing).
- Save files with explicit naming:
  - `profiles/baseline-<flow>.json`

### 2) Analyze Baseline

- Run:

```bash
node scripts/analyze-profile.mjs --input <profile.json> --output <report.json>
```

- Prioritize by:
  - highest `totalMs`
  - high `count`/`trackCount` with moderate/high cost
  - repeated cadence signals indicating timer-driven churn

When `reactComponentTrackEvents` is high but duration events are sparse, prioritize by:

- `reactTracks.topComponentCounts`
- `reactTracks.topComponentCadence`
- `warnings` in the analysis output

When mode is `react-devtools-export`, prioritize by:

- `reactTracks.topComponentCounts`
- `reactTracks.topComponentCadence`
- `reactTracks.topRenderReasons`
- `hotspots[*].topReasons`
- `commits[*].flamegraph.renderedComponents`
- `commits[*].flamegraph.nodes` (rendered components plus ancestor context)

Use aggregations to rank candidates quickly, then confirm every conclusion against specific commit-level evidence in `commits[*]`.

### 3) Map Hotspots To Fix Classes

Use `references/footguns.md` to map profiler evidence to likely causes:

- Context churn from interval or overly broad provider value.
- Broken memoization dependency patterns.
- Missing `React.memo` boundaries for stable-prop children.

Apply minimal patches. Prefer one fix class at a time so deltas remain attributable.

### 4) Re-Profile Same Flows

- Record optimized profiles with the same interaction script.
- Save files:
  - `profiles/optimized-<flow>.json`

### 5) Compare Baseline vs Optimized

- Run:

```bash
node scripts/compare-profiles.mjs --before <baseline-report.json> --after <optimized-report.json>
```

- Confirm:
  - Reduced total React render time when duration metrics are available.
  - Reduced component/scheduler track counts when trace is timestamp-dominant.
  - Reduced hotspot render counts/track counts for targeted components.
  - Removal of periodic commit cadence when timer/context churn is fixed.
  - For React export mode: commit-by-commit improvement across `commits[<index>]`, including rendered component sets, render reasons, and self/subtree timing.

### 6) Report

- Use `references/report-template.md`.
- Include:
  - traces used
  - hotspots before/after
  - patches made
  - measurable deltas
  - residual risks

## Command-Style Invocation

Use this skill directly:

- `Use $react-profiler-optimize to profile <app/flow>, fix top rerender hotspots, and validate with before/after traces.`

If a slash-command wrapper exists in your host environment, map `/react-profile-optimize` to that same prompt.

## Chrome Profiler Confidence Model

Use this model when reporting findings from Chrome Performance Profiler traces:

- Strong confidence:
  - There is a real rerender/perf problem.
  - The impacted component region/subtree can be narrowed down.
  - Cadence-driven churn (for example ~1s interval loops) is present.
- Moderate confidence:
  - The exact code-level footgun class without extra context.
- Use extra instrumentation when needed:
  - Add temporary `performance.mark` in candidate components.
  - Cross-check with React DevTools Profiler export for commit-level details.

## React vs Chrome Capability Matrix

Use both profilers intentionally:

- Chrome Performance Profiler:
  - Strong at proving that a perf problem exists and showing cadence/rerender churn.
  - Good at narrowing to component regions when React tracks are present.
  - Weaker at exact "why did this render" attribution.
- React DevTools Profiler export:
  - Strong at commit-by-commit component render membership and timing.
  - Strong at change-description attribution (`props/state/context/hooks`) when recording reasons is enabled.
  - Export hook changes are index-based by default; recorder now runs vendored DevTools `parseHookNames` at capture time, and CLI analysis prefers runtime inspect-element hook slot enrichment with parseHookNames names when available, then falls back to source-based hook label enrichment.
  - Export now includes parse diagnostics for unresolved hook names (`automationMeta.inspectedElements.hookNameParsing` and per-element `hookNameParsing`), and analyzer surfaces per-fiber unresolved locations.
  - `whyRendered` can still be `unknown` for many samples even with reasons enabled; analyzer reports this coverage explicitly and uses commit updaters + hook slot enrichment as fallback evidence.
  - Includes inspected component source location and owner-chain context when recorder runtime enrichment is present.
  - Weaker at scheduler-lane/process-level attribution compared with Chrome timeline tracks.

## Guardrails

- Do not optimize blindly; every change needs profiler evidence.
- Do not batch many unrelated changes before re-profiling.
- Do not claim improvements without baseline and optimized artifacts.
- If MCP is unavailable, fall back to React DevTools export and continue.
- In large apps, do not jump straight to line-level conclusions from a single trace; narrow to subtree first, then code-level cause.
- If file-level attribution is missing in production traces, add framework source-map config in a profiling environment before claiming tool insufficiency.
- Do not compare raw numbers across dev and production-like runs; compare within one mode, then confirm in the other mode.
