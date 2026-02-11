/**
 * Vendored/adapted from:
 * react/packages/react-devtools-shared/src/hooks/generateHookMap.js
 *
 * We only need decode support here because runtime hook-map generation is not
 * part of the CLI/MCP export pipeline.
 */

import {decode} from '@jridgewell/sourcemap-codec';

export function decodeHookMap(encodedHookMap) {
  if (!encodedHookMap || typeof encodedHookMap !== 'object') {
    return null;
  }

  if (!Array.isArray(encodedHookMap.names) || typeof encodedHookMap.mappings !== 'string') {
    return null;
  }

  return {
    names: encodedHookMap.names,
    mappings: decode(encodedHookMap.mappings),
  };
}
