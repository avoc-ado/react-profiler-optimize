# Expo React Profiler Footguns

This app intentionally includes three common React performance footguns:

1. `useEffect -> setInterval -> setState` in context provider causing frequent context value churn.
2. Broken `useMemo` dependency that uses a fresh object every render.
3. Expensive child component not wrapped in `React.memo`.

## File Map

- `App.tsx`

## Profiling Steps

1. Run app with `npm run web`.
2. Open Chrome DevTools `Performance`.
3. Start recording and leave app idle for 8-12 seconds.
4. Type in the search input and press `Add Item` a few times.
5. Stop recording.

Expected signals:

- Regular commit cadence around 1000ms from interval-driven updates.
- Frequent rerenders in context consumers and shell-level subtree.
- Repeated expensive render work in `ExpensiveBadge` with static props.
- `BrokenMemoList` filtering work reruns even when memoization should help.

Timing caveat:

- A single render can occasionally spike by around ~8ms between adjacent commits with no clear code-level trigger.
- Treat isolated spikes as possible GC/runtime noise unless they repeat across deterministic reruns.
