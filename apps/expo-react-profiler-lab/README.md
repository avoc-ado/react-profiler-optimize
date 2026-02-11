# Expo React Profiler Lab

Expo clone of `next-react-profiler-lab` with the same intentional React performance footguns for profiling practice.

## Stack

- Expo SDK: `54.0.33` (latest at scaffold time)
- React Native: `0.81.5`
- React: `19.1.0`
- New Architecture: enabled (`app.json`)
- React Compiler: disabled (`app.json -> expo.experiments.reactCompiler = false`)

## Footguns Included

1. Context churn from `useEffect -> setInterval -> setState` in provider.
2. Broken `useMemo` dependency on a fresh object every render.
3. Expensive child component not wrapped in `React.memo`.

Main implementation file:

- `App.tsx`

## Run

```bash
npm run web
```

You can also run native targets:

```bash
npm run ios
npm run android
```

## Profiling Flow (Web)

1. Start app with `npm run web`.
2. Open the app URL in Chrome.
3. Open Chrome DevTools -> `Performance`.
4. Record for 8-12 seconds while idle.
5. Type in the search input and press `Add Item` several times.
6. Stop recording and inspect rerender cadence/hotspots.

Supporting docs:

- `docs/react-profiler-footguns-expo.md`
- `docs/chrome-profiler-run-web.md`

## Automated Trace Capture

Start Expo web in one terminal:

```bash
npm run web
```

Capture a deterministic Chrome trace in another terminal:

```bash
npm run profile:web:trace
```

Optional environment overrides:

- `PROFILE_URL` (default: `http://localhost:8081`)
- `PROFILE_OUT` (default: `expo-footguns-trace.json`, written to `profiles/`)
- `CHROME_PATH` (explicit Chrome executable path)
