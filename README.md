# React Profiler Optimize Monorepo

Monorepo for skill-driven, agentic React performance profiling and optimization.

## Start Here: Skill + Agent Profiling Workflow

This is the primary workflow for this repository.

### 1) Prepare environment

```bash
git clone https://github.com/avoc-ado/react-profiler-optimize.git
cd react-profiler-optimize
git submodule update --init --recursive
```

Install dependencies for the app you want to profile and the MCP tool:

```bash
cd apps/next-react-profiler-lab && yarn install
cd ../../tools/react-profiler-mcp && yarn install
```

### 2) Run target app

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

### 3) Run profiler MCP server (tool side)

In another terminal:

```bash
cd tools/react-profiler-mcp
node packages/mcp-server/index.js
```

### 4) Use the packaged skill in your coding agent

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

### 5) Expected profiling loop

1. Capture baseline profile (`record_react_devtools_profile` or CLI `record-react-devtools`).
2. Analyze baseline (`analyze_profile` / CLI `analyze`).
3. Apply one targeted fix class.
4. Capture optimized profile with the same deterministic steps.
5. Compare reports (`compare_profile_reports` or `compare_profiles_end_to_end`).
6. Summarize measurable deltas.

### 6) CLI fallback workflow (without MCP client wiring)

```bash
cd tools/react-profiler-mcp

node packages/cli/bin/react-profiler-cli.js record-react-devtools \
  --url http://localhost:3000 \
  --out /tmp/baseline.json

node packages/cli/bin/react-profiler-cli.js analyze \
  --input /tmp/baseline.json \
  --out /tmp/baseline-report.json \
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
