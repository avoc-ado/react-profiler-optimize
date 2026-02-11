# MCP Profiling Workflow

Use this workflow when Chrome DevTools MCP is available.

For React DevTools Profiler automation (record/stop/export), use `react-profiler-mcp`:

- CLI: `react-profiler-cli record-react-devtools --url ... --out ...`
- MCP tool: `record_react_devtools_profile`

## Preflight

- Ensure app is running locally.
- Ensure Chrome DevTools MCP server is connected.
- Prefer using the same browser profile with React DevTools installed.
- For React >= 19.2, verify React performance tracks are present in trace events.

### React Track Values (Chrome Trace Fields)

Track identity fields:

- Scheduler events: `args.data.trackGroup = "Scheduler ⚛"`, with `args.data.track` lane names.
- Component events: `args.data.track = "Components ⚛"`.
- Server events:
  - `args.data.track = "Server Components ⚛"`
  - `args.data.track = "Server Requests ⚛"`

When tracks appear:

- Scheduler tracks (`Scheduler ⚛`) require profiling builds (`react-dom/profiling`).
- Component tracks (`Components ⚛`) can be emitted via `<Profiler>` or React DevTools profiling.
- Server tracks are available for React Server Components / server rendering traces.

Known Scheduler lane values:

- `Blocking`
- `Gesture` (when gesture transitions are enabled)
- `Transition`
- `Suspense`
- `Idle`

Common Scheduler phase labels (`args.data.name` / `message`):

- Update/event lifecycle:
  - `Event: <type>`
  - `Consecutive`
  - `Update`
  - `Update Blocked`
  - `Cascading Update`
  - `Promise Resolved`
  - `Gesture`
  - `Gesture Blocked`
  - `Action`
- Render lifecycle:
  - `Render`
  - `Prepared`
  - `Hydrated`
  - `Interrupted Render`
  - `Interrupted Hydration`
  - `Prewarm`
  - `Suspended`
  - `Recovered`
  - `Errored`
  - `Teared Render`
- Commit/effect lifecycle:
  - `Commit`
  - `Commit Interrupted View Transition`
  - `Remaining Effects`
  - `Waiting`
  - `Waiting for Paint`
  - `Starting Animation`
  - `Interrupted View Transition`
  - `Animating`
  - `Create Ghost Tree`

Component track labels:

- Component names (for example `AppShell`, `OrdersTable`).
- Trigger markers:
  - `Mount`
  - `Unmount`
  - `Reconnect`
  - `Disconnect`
  - `Suspended`
  - `Action`

Server requests parallel labels:

- `Primary`
- `Parallel` plus up to 8 zero-width-space-padded `Parallel` variants (internally distinct lanes)

## Baseline Pass

1. Navigate to target route.
2. Start performance trace.
3. Perform a deterministic interaction sequence.
4. Stop trace.
5. Save trace JSON as baseline.

Notes:

- If app startup noise is high, wait for idle before starting trace.
- Prefer one trace per flow; avoid mixing unrelated routes/interactions.
- Script interactions when possible (same click/input order and fixed delays).

## Deterministic Interaction Recipe (Generic)

Before recording baseline, define each profiled flow as an explicit recipe.

Recommended fields:

- `flowId`: stable identifier (for example `search-type-and-apply`).
- `route`: URL/path to navigate.
- `preconditions`: required UI state before trace start.
- `steps`: ordered actions.
- `settleMs`: required waits after key actions.
- `outputNames`: baseline/optimized artifact names.

Step action types:

- `navigate` (URL)
- `waitForText` (text, timeout)
- `click` (selector/uid)
- `fill` (selector/uid, value)
- `pressKey` (key combo)
- `wait` (milliseconds)

Example template:

```yaml
flowId: <flow-id>
route: <route-or-url>
preconditions:
  - <condition-1>
steps:
  - action: navigate
    target: <route-or-url>
  - action: wait
    ms: 1500
  - action: click
    target: <selector-or-uid>
  - action: fill
    target: <selector-or-uid>
    value: <text>
  - action: wait
    ms: 1000
outputNames:
  baseline: profiles/baseline-<flow-id>.json
  optimized: profiles/optimized-<flow-id>.json
```

Execution guidance:

- Canonical: execute steps sequentially (each step logged), then stop trace.
- Optional: wrap in a helper command/script only if it preserves ordered, step-level execution and logs.
- Avoid one opaque command that hides intermediate failures.

## Optimization Pass

1. Apply one fix class at a time.
2. Repeat exact interaction sequence.
3. Save trace JSON as optimized.

## React DevTools Automated Capture (Record/Stop/Export)

Use this when commit-level React Profiler data is required (`why-rendered`, commit flamegraph parity).

1. Reach target route/state.
2. Start recording with `recordChangeDescriptions: true`.
3. Execute deterministic interaction steps.
4. Stop profiling.
5. Export JSON (`version: 5`) and analyze with `scripts/analyze-profile.mjs`.

Recorder requirement:

- Browser launchable Chrome/Chromium path for Puppeteer (`--chrome-path` or `CHROME_PATH` when auto-detection fails).
- Keep attribution defaults on unless you have a strong reason not to:
  - `recordChangeDescriptions=true`
  - `inspectElements=true`
  - `parseHookNames=true`
- Enterprise default knobs:
  - `inspectElementsMaxPerRoot=1500`
  - `inspectElementsTimeoutMs=4000`
  - `inspectElementsConcurrency=8`
  - `parseHookNamesTimeoutMs=5000`
- Next.js/source alias support:
  - pass `--parse-hook-names-source-root <repo-root>` (or MCP `parseHookNamesSourceRoots`) so `@/*` and tsconfig/jsconfig `paths` aliases can be resolved when needed.

## Profiling Mode Strategy

Use two modes for enterprise workflows:

- Attribution pass (default):
  - Run in local dev (`next dev` / framework dev server) for best source maps and faster code navigation.
- Realism pass:
  - Run in production-like build/runtime to validate perf impact under realistic bundling and scheduling.

Do not compare absolute numbers across different modes. Compare before/after inside the same mode.

## Analysis

- Run `scripts/analyze-profile.mjs` on both files.
- Run `scripts/compare-profiles.mjs` for deltas.
- Confirm targeted component and commit-level improvements.
- For React track-heavy traces, also compare:
  - `reactTracks.topComponentCounts`
  - `reactTracks.topComponentCadence`
  - `reactTracks.topSchedulerLanes`
  - `reactTracks.topSchedulerPhases`
  - `totals.reactComponentTrackEvents`
  - `totals.reactSchedulerTrackEvents`

## React DevTools Export Normalized Schema (Agent Ingestion)

When input mode is `react-devtools-export`, analysis output includes:

- `commits[]`: one item per React commit, in chronological order.
  - `commitIndex`, `timestampMs`, `durationMs`, `effectDurationMs`, `passiveEffectDurationMs`, `priorityLevel`
  - `flamegraph.renderedComponents`: rendered component list for that commit
  - `flamegraph.nodes`: tree nodes (rendered components + ancestor context)

Node-level fields (`commits[*].flamegraph.nodes[*]`):

- `fiberId`, `parentFiberId`, `childrenFiberIds`, `depth`
- `name`, `type`, `key`
- `selfMs`
- `subtreeMs` (from React export `fiberActualDurations` when available)
- `computedSubtreeMs` (computed from self durations across descendants)
- `inspectedSource` (from runtime `inspectElement` enrichment when available)
- `inspectedOwners` (owner chain from runtime `inspectElement` enrichment when available)
- `whyRendered`:
  - `summary` (e.g. `props+hooks`)
  - `propsChanged`, `stateChanged`, `contextChanged`, `hooksChanged`
  - `isFirstMount`, `didHooksChange`
  - `hooksChanged` entries are hook indexes from profiler change descriptions.
  - Analyzer adds `hooksChangedDetails[]` from runtime `inspectElement` slot metadata when available.
  - Analyzer falls back to best-effort source-based labels (`useState`, `useMemo`, etc.) when runtime metadata is missing.
  - `hooksChangedDetailsSource` indicates whether details came from `runtime-inspect-element` or `source-static-parse`.

Use this structure to compare commits `N`, `N+1`, `N+2` directly:

- Which components rendered.
- Which render reasons changed.
- Whether self/subtree cost moved in the expected direction.

UI-parity fields:

- Commit selector/tooltip:
  - `commits[*].timestampMs`
  - `commits[*].durationMs`
  - `commits[*].effectDurationMs`
  - `commits[*].passiveEffectDurationMs`
  - `commits[*].priorityLevel`
- Commit sidebar "What caused this update?":
  - `commits[*].updaters[]`
- Flamegraph:
  - `commits[*].flamegraph.nodes[]`
  - `commits[*].flamegraph.nodes[*].treeBaseDurationMs`
  - `commits[*].flamegraph.nodes[*].selfMs`
  - `commits[*].flamegraph.nodes[*].subtreeMs`
- Ranked chart:
  - `commits[*].rankedBySelfMs[]`
- "Why did this render?":
  - `commits[*].flamegraph.nodes[*].whyRendered`

Runtime inspector sidecar fields (in exported profile JSON):

- `automationMeta.inspectedElements.roots[*].elements[*].source`
- `automationMeta.inspectedElements.roots[*].elements[*].owners`
- `automationMeta.inspectedElements.roots[*].elements[*].hookSlots`
- `automationMeta.inspectedElements.roots[*].elements[*].hookNameParsing` (per-element parse diagnostics)
- `automationMeta.inspectedElements.hookNameParsing` (global parse totals)

Aggregation guidance:

- Treat per-commit structures above as the source of truth.
- Treat `hotspots`, cadence, and top-* lists as convenience indexes only.
- If aggregation conflicts with commit-level data, trust commit-level data.

## How To Interpret Chrome Trace Signals

Use these as default heuristics:

- Problem existence:
  - Significant repeated rerender counts for stable UI areas.
  - Regular cadence with no user action.
- Problem localization:
  - Components repeatedly appearing in `reactTracks.topComponentCounts`.
  - Components with regular cadence in `reactTracks.topComponentCadence`.
- Footgun hypothesis strength:
  - High when cadence and component scope align with known patterns.
  - Medium when only generic rerender spikes are visible.

## Practical Readout From `next-react-profiler-lab`

In the lab traces, Chrome React tracks were sufficient to:

- Confirm a real rerender problem exists (strong periodic cadence ~1s).
- Narrow to concrete components (`LabProvider`, `BrokenMemoList`, `LabShell`, `TickReadout`, `ContextConsumerGrid`, `ExpensiveBadge`).
- Detect likely broad context churn and repeated expensive child rerenders.

Chrome traces alone were not sufficient to:

- Explain exact per-commit "why-rendered" reasons (`props/state/context/hooks`) at component level.
- Provide commit-level component tree timing parity with React DevTools flamegraph/ranked views.

Use React DevTools exports when you need those two capabilities.

## Known Limits And Mitigations

- Limit: Chrome trace may not directly expose exact code-line cause.
  - Mitigation: inspect narrowed components and apply one fix class at a time.
- Limit: production bundles can hide file/line attribution unless source maps are emitted.
  - Mitigation (Next.js): prefer `next dev` for file/line attribution; keep production browser source maps disabled by default.
- Limit: duration-based metrics can underrepresent React 19 component tracks because many are timestamp events.
  - Mitigation: treat component track count/cadence as primary for churn detection.
- Limit: one trace can be noisy in enterprise apps.
  - Mitigation: run at least two baseline traces and compare consistency.
- Limit: deep "why did this render" attribution is weaker than React DevTools Profiler.
  - Mitigation: cross-check with React DevTools export when needed.
- Limit: StrictMode in dev can increase render/effect activity and inflate counts.
  - Mitigation: keep mode consistent for before/after; if needed, validate final deltas in production-like mode.
- Limit: React DevTools export has no scheduler-lane tracks equivalent to Chrome trace scheduler tracks.
  - Mitigation: use export mode for component-level rerender counts/cadence/reasons and use Chrome traces when scheduler-lane attribution is required.
- Limit: many exported `whyRendered` entries may be `unknown` even with change descriptions enabled.
  - Mitigation: rely on commit membership + timing + updaters for localization, then confirm likely footgun class in source.
  - Analyzer now reports render-reason coverage and warns when unknown dominates; treat unknown as expected limitation, not exporter failure.
- Limit: full DevTools runtime hook-source resolution parity (custom-hook source names) is not always available in pure export mode.
- Limit: parseHookNames output can still be partial when runtime source URLs are not fetchable or source-map source content is unavailable.
  - Mitigation: keep runtime inspect-element enrichment enabled, keep source-root fallback enabled, and treat unresolved custom-hook names as non-blocking unless they are required for a specific fix decision.
  - Analyzer surfaces per-fiber unresolved diagnostics under `enrichment.runtimeInspect.hookNameParsing.unresolvedElementDiagnostics` so unresolved mappings can be debugged quickly.

## Next.js Source Mapping Callout

Default enterprise recommendation:

- Do not enable public production browser source maps globally.
- Profile locally in `next dev` first (source maps are already available).
- If you need production-like profiling with file mapping, use an isolated profiling environment and gate source maps behind env flags.

Example (default-off, opt-in only):

```ts
// next.config.ts
import type { NextConfig } from "next";

const enableProfilingSourceMaps = process.env.ENABLE_PROFILING_SOURCEMAPS === "1";

const nextConfig: NextConfig = {
  productionBrowserSourceMaps: enableProfilingSourceMaps,
};

export default nextConfig;
```

Notes:

- Keep `ENABLE_PROFILING_SOURCEMAPS` unset in normal production.
- In local dev, Next.js already provides source maps by default.

## If MCP Is Unavailable

- Use React DevTools Profiler export JSON.
- Run the same scripts; export mode is normalized into comparable component-level metrics.
- Continue with before/after comparison and documented findings.
