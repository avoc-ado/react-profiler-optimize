# Upstream Provenance

This directory vendors code adapted from the React repository:

- Repo: https://github.com/facebook/react
- Source subtree: `packages/react-devtools-shared/src/hooks`
- Related file: `packages/react-devtools-shared/src/hookSourceLocation.js`

The files here are intentionally kept close to upstream logic so they can be
re-synced in future updates.

Notes:

- Upstream files are Flow-typed and browser-worker oriented.
- This vendored copy is adapted to Node ESM runtime for CLI/MCP usage.
- Functional intent is preserved: parse hook names from inspected hooks trees
  via source maps (including React hook maps) with AST fallback.
