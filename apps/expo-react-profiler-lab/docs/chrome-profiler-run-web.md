# Chrome Profiler Run (Expo Web)

## App Setup

- App: `expo-react-profiler-lab`
- Profile target: Expo web build (`npm run web`)
- Primary implementation: `App.tsx`

## Injected Footguns

1. Context churn via `useEffect -> setInterval -> setState` in provider.
2. Broken `useMemo` dependency with unstable object dependency.
3. Expensive child component without `React.memo`.

## Suggested Trace Script

Automated run:

```bash
npm run profile:web:trace
```

Manual fallback:

1. Start `npm run web`.
2. Open app URL in Chrome.
3. Open DevTools `Performance`.
4. Start recording.
5. Wait idle ~8 seconds.
6. Change search text and press `Add Item` 2-3 times.
7. Wait ~2 seconds and stop recording.

## Interpretation Checklist

- Do you see roughly 1-second rerender cadence?
- Does `BrokenMemoList` rerender repeatedly with interval ticks?
- Does `ExpensiveBadge` rerender despite static props?
- Do broad sections rerender from provider changes?
