/**
 * Vendored/adapted from:
 * react/packages/react-devtools-shared/src/hooks/parseHookNames/parseSourceAndMetadata.js
 */

import {parse} from '@babel/parser';

import {getHookName} from './astUtils.js';
import createSourceMapConsumer from './sourceMapConsumer.js';
import {SourceMapMetadataConsumer} from './sourceMapMetadataConsumer.js';
import {getHookSourceLocationKey} from './hookSourceLocation.js';

const MAX_CACHE_ENTRIES = 50;

const runtimeURLToMetadataCache = new Map();
const originalURLToMetadataCache = new Map();

function setWithLruLimit(map, key, value, maxEntries = MAX_CACHE_ENTRIES) {
  if (map.has(key)) {
    map.delete(key);
  }
  map.set(key, value);
  if (map.size > maxEntries) {
    const first = map.keys().next();
    if (!first.done) {
      map.delete(first.value);
    }
  }
}

function areSourceMapsAppliedToErrors() {
  return false;
}

export async function parseSourceAndMetadata(hooksList, locationKeyToHookSourceAndMetadata) {
  const locationKeyToHookParsedMetadata = initializeHookParsedMetadata(
    locationKeyToHookSourceAndMetadata,
  );

  parseSourceMaps(locationKeyToHookSourceAndMetadata, locationKeyToHookParsedMetadata);
  parseSourceAST(locationKeyToHookSourceAndMetadata, locationKeyToHookParsedMetadata);

  return findHookNames(hooksList, locationKeyToHookParsedMetadata);
}

function initializeHookParsedMetadata(locationKeyToHookSourceAndMetadata) {
  const locationKeyToHookParsedMetadata = new Map();

  locationKeyToHookSourceAndMetadata.forEach((_hookSourceAndMetadata, locationKey) => {
    locationKeyToHookParsedMetadata.set(locationKey, {
      metadataConsumer: null,
      originalSourceAST: null,
      originalSourceCode: null,
      originalSourceURL: null,
      originalSourceLineNumber: null,
      originalSourceColumnNumber: null,
      sourceMapConsumer: null,
    });
  });

  return locationKeyToHookParsedMetadata;
}

function parseSourceMaps(locationKeyToHookSourceAndMetadata, locationKeyToHookParsedMetadata) {
  locationKeyToHookSourceAndMetadata.forEach((hookSourceAndMetadata, locationKey) => {
    const hookParsedMetadata = locationKeyToHookParsedMetadata.get(locationKey);
    if (hookParsedMetadata == null) {
      throw new Error(`Expected to find HookParsedMetadata for "${locationKey}"`);
    }

    const {runtimeSourceURL, sourceMapJSON} = hookSourceAndMetadata;
    const runtimeMetadata = runtimeURLToMetadataCache.get(runtimeSourceURL);

    if (runtimeMetadata != null) {
      hookParsedMetadata.metadataConsumer = runtimeMetadata.metadataConsumer;
      hookParsedMetadata.sourceMapConsumer = runtimeMetadata.sourceMapConsumer;
      return;
    }

    if (sourceMapJSON != null) {
      const sourceMapConsumer = createSourceMapConsumer(sourceMapJSON);
      const metadataConsumer = new SourceMapMetadataConsumer(sourceMapJSON);

      hookParsedMetadata.metadataConsumer = metadataConsumer;
      hookParsedMetadata.sourceMapConsumer = sourceMapConsumer;

      setWithLruLimit(runtimeURLToMetadataCache, runtimeSourceURL, {
        metadataConsumer,
        sourceMapConsumer,
      });
    }
  });
}

function parseSourceAST(locationKeyToHookSourceAndMetadata, locationKeyToHookParsedMetadata) {
  locationKeyToHookSourceAndMetadata.forEach((hookSourceAndMetadata, locationKey) => {
    const hookParsedMetadata = locationKeyToHookParsedMetadata.get(locationKey);
    if (hookParsedMetadata == null) {
      throw new Error(`Expected to find HookParsedMetadata for "${locationKey}"`);
    }

    if (hookParsedMetadata.originalSourceAST !== null) {
      return;
    }

    if (
      hookParsedMetadata.originalSourceURL != null &&
      hookParsedMetadata.originalSourceCode != null &&
      hookParsedMetadata.originalSourceColumnNumber != null &&
      hookParsedMetadata.originalSourceLineNumber != null
    ) {
      return;
    }

    const {lineNumber, columnNumber} = hookSourceAndMetadata.hookSource;
    if (lineNumber == null || columnNumber == null) {
      throw new Error('Hook source code location not found.');
    }

    const {metadataConsumer, sourceMapConsumer} = hookParsedMetadata;
    const runtimeSourceCode = hookSourceAndMetadata.runtimeSourceCode;

    let hasHookMap = false;
    let originalSourceURL;
    let originalSourceCode;
    let originalSourceColumnNumber;
    let originalSourceLineNumber;

    if (areSourceMapsAppliedToErrors() || sourceMapConsumer === null) {
      originalSourceColumnNumber = columnNumber;
      originalSourceLineNumber = lineNumber;
      originalSourceCode = runtimeSourceCode;
      originalSourceURL = hookSourceAndMetadata.runtimeSourceURL;
    } else {
      try {
        const {column, line, sourceContent, sourceURL} = sourceMapConsumer.originalPositionFor({
          columnNumber,
          lineNumber,
        });

        if (sourceContent === null || sourceURL === null) {
          originalSourceColumnNumber = columnNumber;
          originalSourceLineNumber = lineNumber;
          originalSourceCode = runtimeSourceCode;
          originalSourceURL = hookSourceAndMetadata.runtimeSourceURL;
        } else {
          originalSourceColumnNumber = column;
          originalSourceLineNumber = line;
          originalSourceCode = sourceContent;
          originalSourceURL = sourceURL;
        }
      } catch {
        originalSourceColumnNumber = columnNumber;
        originalSourceLineNumber = lineNumber;
        originalSourceCode = runtimeSourceCode;
        originalSourceURL = hookSourceAndMetadata.runtimeSourceURL;
      }
    }

    hookParsedMetadata.originalSourceCode = originalSourceCode;
    hookParsedMetadata.originalSourceURL = originalSourceURL;
    hookParsedMetadata.originalSourceLineNumber = originalSourceLineNumber;
    hookParsedMetadata.originalSourceColumnNumber = originalSourceColumnNumber;

    if (metadataConsumer != null && metadataConsumer.hasHookMap(originalSourceURL)) {
      hasHookMap = true;
    }

    if (hasHookMap) {
      return;
    }

    if (typeof originalSourceCode !== 'string' || originalSourceCode.length === 0) {
      return;
    }

    if (typeof originalSourceURL !== 'string' || originalSourceURL.length === 0) {
      return;
    }

    const sourceMetadata = originalURLToMetadataCache.get(originalSourceURL);
    if (sourceMetadata != null) {
      hookParsedMetadata.originalSourceAST = sourceMetadata.originalSourceAST;
      hookParsedMetadata.originalSourceCode = sourceMetadata.originalSourceCode;
      return;
    }

    try {
      const plugin = originalSourceCode.indexOf('@flow') > 0 ? 'flow' : 'typescript';
      const originalSourceAST = parse(originalSourceCode, {
        sourceType: 'unambiguous',
        plugins: ['jsx', plugin],
      });

      hookParsedMetadata.originalSourceAST = originalSourceAST;

      setWithLruLimit(originalURLToMetadataCache, originalSourceURL, {
        originalSourceAST,
        originalSourceCode,
      });
    } catch {
      hookParsedMetadata.originalSourceAST = null;
    }
  });
}

function findHookNames(hooksList, locationKeyToHookParsedMetadata) {
  const map = new Map();

  hooksList.forEach((hook) => {
    const hookSource = hook.hookSource;
    const fileName = hookSource?.fileName;
    if (!fileName) {
      return;
    }

    const locationKey = getHookSourceLocationKey(hookSource);
    const hookParsedMetadata = locationKeyToHookParsedMetadata.get(locationKey);
    if (!hookParsedMetadata) {
      return;
    }

    const {lineNumber, columnNumber} = hookSource;
    if (!lineNumber || !columnNumber) {
      return;
    }

    const {
      originalSourceURL,
      originalSourceColumnNumber,
      originalSourceLineNumber,
      metadataConsumer,
    } = hookParsedMetadata;

    if (
      originalSourceLineNumber == null ||
      originalSourceColumnNumber == null ||
      originalSourceURL == null
    ) {
      return;
    }

    let name = null;
    if (metadataConsumer != null) {
      name = metadataConsumer.hookNameFor({
        line: originalSourceLineNumber,
        column: originalSourceColumnNumber,
        source: originalSourceURL,
      });
    }

    if (
      name == null &&
      hookParsedMetadata.originalSourceAST != null &&
      typeof hookParsedMetadata.originalSourceCode === 'string'
    ) {
      name = getHookName(
        hook,
        hookParsedMetadata.originalSourceAST,
        hookParsedMetadata.originalSourceCode,
        originalSourceLineNumber,
        originalSourceColumnNumber,
      );
    }

    map.set(getHookSourceLocationKey(hookSource), name);
  });

  return map;
}

export function purgeCachedMetadata() {
  originalURLToMetadataCache.clear();
  runtimeURLToMetadataCache.clear();
}
