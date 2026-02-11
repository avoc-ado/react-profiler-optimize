# React Profiler Optimize Monorepo

Monorepo for automated React rendering performance profiling and optimization workflows.

This repository packages:

- Two profiling labs (Next.js and Expo Web) with intentional footguns.
- A production-oriented MCP/CLI automation toolkit for React DevTools profiling export and analysis.
- A canonical, in-repo `react-profiler-optimize` Codex skill.
- An optional `vendor/react` submodule for upstream React DevTools provenance and re-sync workflows.

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

## Why This Layout

- `apps/*` stays focused on runnable profiling targets.
- `tools/react-profiler-mcp` stays focused on automation (record/analyze/compare).
- `skills/react-profiler-optimize` is the canonical skill source to package and version with this repo.
- `vendor/react` is optional for maintainers who need upstream parity checks; normal users do not need to touch it.

## Prerequisites

- Node.js 20+
- `yarn` and/or `npm`
- Git 2.40+
- GitHub CLI (`gh`) authenticated
- Chrome/Chromium available for automated profiling capture (Puppeteer)

## Clone

```bash
git clone https://github.com/avoc-ado/react-profiler-optimize.git
cd react-profiler-optimize
git submodule update --init --recursive
```

## Quick Start

### 1) Run a Lab App

Next.js lab:

```bash
cd apps/next-react-profiler-lab
yarn install
yarn dev
```

Expo web lab:

```bash
cd apps/expo-react-profiler-lab
npm install
npm run web
```

### 2) Run MCP/CLI Tooling

```bash
cd tools/react-profiler-mcp
yarn install
node packages/cli/bin/react-profiler-cli.js --help
```

Example recording + analysis:

```bash
node packages/cli/bin/react-profiler-cli.js record-react-devtools \
  --url http://localhost:3000 \
  --out /tmp/baseline.json

node packages/cli/bin/react-profiler-cli.js analyze \
  --input /tmp/baseline.json \
  --out /tmp/baseline-report.json \
  --source-root ../../apps/next-react-profiler-lab
```

## Canonical Skill Packaging

Canonical skill source is in-repo:

- `skills/react-profiler-optimize/SKILL.md`
- `skills/react-profiler-optimize/references/*`
- `skills/react-profiler-optimize/scripts/*`
- `skills/react-profiler-optimize/agents/openai.yaml`

`react-profiler-mcp` is configured to prefer this in-repo skill first, with `.skill-edit` and `~/.codex` as fallbacks.

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

Update to latest upstream:

```bash
git submodule update --remote vendor/react
```

Current intent:

- Keep vendored hook parsing logic in `tools/react-profiler-mcp/packages/core/src/vendor/react-devtools-shared/`.
- Use `vendor/react` to inspect and re-sync upstream changes when needed.

## Notes

- Generated traces/profiles/reports and local workspace artifacts are ignored at repo root.
- This repository is intentionally optimized for reproducible perf workflows, not long-term storage of raw trace dumps.
