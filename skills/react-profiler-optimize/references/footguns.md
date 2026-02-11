# Common React Profiler Footguns

Use this reference to map profiler evidence to likely root causes and fixes.

## 1) Interval-driven context churn

Pattern:

- `useEffect` starts `setInterval`.
- Interval updates state in a provider.
- Provider `value` changes every tick.
- Every `useContext` consumer rerenders.

Profiler signals:

- Commits at a regular cadence (often ~1000ms).
- Large subtree rerendering with no user interaction.
- High repeated counts in React component tracks for many `useContext` consumers.

Typical fixes:

- Remove timer state from broad context.
- Split context by concern.
- Memoize provider values and avoid unrelated fields in shared value objects.

Pilot example:

- `jet-v1-react/src/contexts/localization/localization.tsx`

## 2) Broken memo dependencies

Pattern:

- `useMemo(..., [ { someObject } ])` with a fresh object literal each render.
- Memo invalidates every render, so expensive work reruns.

Profiler signals:

- Component keeps doing expensive render work after unrelated parent updates.
- "Memoized" path shows no practical reduction in render cost.
- Component appears repeatedly in `reactTracks.topComponentCounts` even when inputs are logically unchanged.

Typical fixes:

- Depend directly on stable values.
- Memoize dependency objects before using them as dependencies.

Pilot example:

- `jet-v1-react/src/components/MarketTable.tsx`

## 3) Missing `React.memo` on stable-prop child

Pattern:

- Child component has expensive render logic.
- Parent rerenders frequently due to unrelated state/context changes.
- Child receives stable props but still rerenders.

Profiler signals:

- Same child appears across many commits with similar props.
- High repeated self-time in unchanged UI blocks.
- In React component tracks, child rerender cadence mirrors parent/context cadence despite stable props.

Typical fixes:

- Wrap child with `React.memo`.
- Stabilize child props and callbacks.

Pilot example:

- `jet-v1-react/src/components/StaticPerfFootgun.tsx`
- `jet-v1-react/src/views/Cockpit.tsx`

## 4) GC jitter mistaken for component regression

Pattern:

- A single component render occasionally spikes by a few milliseconds (often around +5ms to +10ms) between adjacent commits.
- No meaningful prop/state/context change pattern explains the spike.

Profiler signals:

- One-off or irregular self-time spikes on otherwise stable components.
- Spike does not reproduce consistently across repeated baseline runs.
- Commit-level cadence and rerender membership stay mostly unchanged.

Interpretation:

- This can be JavaScript garbage collection or unrelated runtime scheduler noise, not a React logic regression.

Mitigation:

- Re-run deterministic baseline/optimized captures multiple times.
- Compare medians/P95 and repeated commit patterns, not single-spike outliers.
- Treat isolated ±8ms swings as low-confidence evidence unless accompanied by repeatable rerender growth.
