# Chrome Profiler Run (React Performance Tracks)

## App Setup

- App: `next-react-profiler-lab`
- React: `19.2.3`
- Profiling mode: Chrome DevTools MCP `performance_start_trace` / `performance_stop_trace`
- Dev server: `WATCHPACK_POLLING=true yarn dev --port 3001 --webpack`

## Injected Footguns

1. Context churn via `useEffect -> setInterval -> setState` in provider.
2. Broken `useMemo` dependency with unstable object dependency.
3. Expensive child component without `React.memo`.

Primary implementation file:

- `src/components/ProfilerLab.tsx`

## Trace Artifacts

- `profiles/chrome-devtools-mcp-trace-v5.json`
- `profiles/chrome-devtools-mcp-footgun-analysis-v5.json`

## Evidence from Trace v5

From `profiles/chrome-devtools-mcp-footgun-analysis-v5.json`:

- `LabProvider` component track events: **117**
- `LabShell` component track events: **41**
- `BrokenMemoList` component track events: **43**
- `ContextConsumerGrid` component track events: **41**
- `TickReadout` component track events: **41**
- `ExpensiveBadge` component track events: **41**

Cadence signals:

- `BrokenMemoList` median rerender delta: **1010.11ms**
- `ContextConsumerGrid` median rerender delta: **1010.13ms**
- `TickReadout` median rerender delta: **1010.13ms**
- `LabShell` median rerender delta: **1010.13ms**

Render mark counts:

- `ExpensiveBadge:render`: **82**
- `BrokenMemoList:render`: **86**

Interpretation:

1. The ~1s rerender cadence matches interval-driven provider updates.
2. `BrokenMemoList` rerenders at the interval cadence and also around user interactions, consistent with broken memo dependencies.
3. `ExpensiveBadge` rerenders frequently despite stable `label` prop, which is the missing-`React.memo` symptom this lab is designed to expose.

## Notes

- Generic `analyze-profile.mjs` currently under-detects React tracks in this trace format; targeted parsing of React Performance Track events was used for this run.
