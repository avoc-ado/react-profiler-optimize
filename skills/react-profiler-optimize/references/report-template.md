# React Profiling Optimization Report

## Scope

- App:
- Flow(s):
- Constraints:

## Baseline Artifacts

- Baseline trace/profile:
- Baseline analysis report:
- Baseline mode: `chrome-trace` | `react-devtools-export`

## Top Hotspots (Before)

1.
2.
3.

## Changes Applied

1.
2.
3.

## Optimized Artifacts

- Optimized trace/profile:
- Optimized analysis report:
- Comparison report:
- Optimized mode: `chrome-trace` | `react-devtools-export`

## Measured Deltas

- Total React time:
- Commit count:
- Commit-by-commit deltas (`N`, `N+1`, `N+2`) from `commits[*].flamegraph.renderedComponents`:
- Target hotspot deltas:
- Target component track count/cadence deltas:
- Target render-reason deltas:
- Scheduler lane/phase deltas:
- Interval cadence removed/present:

## Confidence And Visibility

- Profiler source used: Chrome Performance | React DevTools | both
- Chrome trace had React component tracks (`Components ⚛`): yes / no
- Confidence in problem existence:
- Confidence in narrowed component scope:
- Confidence in exact code-level footgun:
- Extra instrumentation used (`performance.mark`, React Profiler export):

## Risk Check

- Behavior regressions:
- Visual regressions:
- Incomplete coverage:

## Final Outcome

- Status: improved / mixed / regressed
- Next actions:
