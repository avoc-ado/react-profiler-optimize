# React Profiler Optimize Monorepo

Monorepo for skill-driven, agentic React performance profiling and optimization.

## Start Here: End-to-End Agent Workflow

This is the primary workflow for this repository, including everything the agent should do from app startup through verified optimization.

### 1) Prepare environment

```bash
git clone https://github.com/avoc-ado/react-profiler-optimize.git
cd react-profiler-optimize
git submodule update --init --recursive
```

Install dependencies for the app you want to profile and the profiler MCP tool:

```bash
cd apps/next-react-profiler-lab && yarn install
cd ../../tools/react-profiler-mcp && yarn install
```

### 2) Run target app and confirm readiness

Next lab:

```bash
cd apps/next-react-profiler-lab
yarn dev
```

Expo web lab:

```bash
cd apps/expo-react-profiler-lab
npm install
npm run web
```

When running the app, the agent should:

1. Wait for the dev server to become reachable.
2. Open the target route in Chrome Devtools MCP.
3. Confirm page readiness (selector/text/URL) before recording.

### 3) Start profiling tool servers

Run React profiling MCP (record/analyze/compare):

In another terminal:

```bash
cd tools/react-profiler-mcp
node packages/mcp-server/index.js
```

Optional but recommended for browser-level trace scouting:

- Start `chrome-devtools-mcp` in your agent client to enable navigation, interaction replay, and Chrome Performance traces.

### 4) Invoke the packaged skill in your coding agent

Canonical skill lives in:

- `skills/react-profiler-optimize/SKILL.md`
- `skills/react-profiler-optimize/references/*`
- `skills/react-profiler-optimize/scripts/*`

Use this prompt pattern in your agent:

```text
Use $react-profiler-optimize to profile apps/next-react-profiler-lab.
Capture baseline, analyze hotspots, apply a targeted fix, re-profile,
and produce before/after deltas.
```

### 5) Agent execution loop (what the agent should do)

1. Navigate and interact deterministically.
2. Run a baseline Chrome trace (if `chrome-devtools-mcp` is connected) to prove a real perf issue and cadence.
3. Run a baseline React DevTools export capture with `record_react_devtools_profile`.
4. Analyze the baseline export (`analyze_profile`) and rank hotspots.
5. Narrow to concrete files/components using commit-level evidence and render reasons.
6. Apply a minimal fix to one class of issue at a time.
7. Re-run the exact same interaction sequence.
8. Capture optimized profile and compare (`compare_profile_reports` or `compare_profiles_end_to_end`).
9. Report measurable deltas and any residual risks.

### 6) Typical hotspot-to-code narrowing flow

1. Start from `commits[*].flamegraph.nodes[*]` and `whyRendered`.
2. Cross-check recurring components in `reactTracks.topComponentCounts` and cadence.
3. Map to source files in `apps/*` (usually provider, memo boundary, or expensive child component).
4. Patch only the minimal lines required for the targeted footgun.

### 7) Suggested artifact naming

1. `profiles/baseline-<flow>.json`
2. `reports/baseline-<flow>.report.json`
3. `profiles/optimized-<flow>.json`
4. `reports/optimized-<flow>.report.json`
5. `reports/<flow>.diff.json`

### 8) CLI fallback workflow (without MCP client wiring)

```bash
cd tools/react-profiler-mcp

node packages/cli/bin/react-profiler-cli.js record-react-devtools \
  --url http://localhost:3000 \
  --out /tmp/baseline.json

node packages/cli/bin/react-profiler-cli.js analyze \
  --input /tmp/baseline.json \
  --out /tmp/baseline-report.json \
  --source-root ../../apps/next-react-profiler-lab

node packages/cli/bin/react-profiler-cli.js compare-profiles \
  --before-profile /tmp/baseline.json \
  --after-profile /tmp/optimized.json \
  --out /tmp/compare.json \
  --source-root ../../apps/next-react-profiler-lab
```

## Repository Layout

```text
.
├── apps/
│   ├── next-react-profiler-lab/
│   └── expo-react-profiler-lab/
├── tools/
│   └── react-profiler-mcp/
├── skills/
│   └── react-profiler-optimize/
└── vendor/
    └── react/                # git submodule -> facebook/react
```

## What Each Area Is For

- `apps/*`: profiling targets with intentional perf footguns.
- `tools/react-profiler-mcp`: recorder + analysis MCP server and CLI.
- `skills/react-profiler-optimize`: canonical skill to package/version with this repo.
- `vendor/react`: optional upstream checkout for parity/resync maintenance.

## Skill Packaging Notes

`react-profiler-mcp` is configured to resolve skill roots in this order:

1. In-repo `skills/react-profiler-optimize` (preferred)
2. `.skill-edit/react-profiler-optimize` (workspace fallback)
3. `~/.codex/skills/react-profiler-optimize` (user fallback)

Optional local install for Codex:

```bash
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
cp -R skills/react-profiler-optimize "${CODEX_HOME:-$HOME/.codex}/skills/react-profiler-optimize"
```

## Working With `vendor/react` Submodule

Initialize:

```bash
git submodule update --init --recursive
```

Update:

```bash
git submodule update --remote vendor/react
```

Maintainer intent:

- Keep vendored hook parsing logic in `tools/react-profiler-mcp/packages/core/src/vendor/react-devtools-shared/`.
- Use `vendor/react` for upstream diffing/resync workflows when needed.

## Prerequisites

- Node.js 20+
- `yarn` and/or `npm`
- Git 2.40+
- GitHub CLI (`gh`) authenticated
- Chrome/Chromium available for automated profiling capture (Puppeteer)

## Notes

- Generated traces/profiles/reports and local workspace artifacts are ignored at repo root.
- This repo is designed for reproducible optimization workflows, not long-term storage of raw trace dumps.
