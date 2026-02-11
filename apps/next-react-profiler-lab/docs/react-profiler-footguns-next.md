# Next.js React Profiler Footguns

This app intentionally includes three common React performance footguns:

1. `useEffect -> setInterval -> setState` in context provider causing frequent context value changes and broad rerenders.
2. Broken `useMemo` dependency using a fresh object dependency every render.
3. Expensive child component that is not wrapped in `React.memo`.

## File Map

- `src/components/ProfilerLab.tsx`
- `src/app/page.tsx`

## Profiling Steps (Chrome Performance)

1. Run app with `yarn dev`.
2. Open Chrome DevTools `Performance`.
3. Start recording and leave idle for 8-12 seconds.
4. Type in the search box and click `Add Item` a few times.
5. Stop recording.

Expected signals:

- Regular commit cadence around 1000ms.
- Repeated rerenders in context consumers.
- Repeated expensive render work in `ExpensiveBadge` with static props.
- `BrokenMemoList` work not effectively memoized.

Timing caveat:

- A single render can occasionally jump by roughly ~8ms between adjacent commits with no code-change reason.
- Treat these isolated spikes as potential GC/runtime noise unless they repeat across multiple deterministic runs.
