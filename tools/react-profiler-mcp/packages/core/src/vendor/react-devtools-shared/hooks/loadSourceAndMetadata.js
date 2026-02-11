/**
 * Vendored/adapted from:
 * react/packages/react-devtools-shared/src/hooks/parseHookNames/loadSourceAndMetadata.js
 */

import {getHookSourceLocationKey} from './hookSourceLocation.js';
import {sourceMapIncludesSource} from './sourceMapUtils.js';

const FETCH_OPTIONS = {cache: 'force-cache'};
const MAX_SOURCE_LENGTH = 100_000_000;

function isUnnamedBuiltInHook(hook) {
  return ['Effect', 'ImperativeHandle', 'LayoutEffect', 'DebugValue'].includes(hook.name);
}

export function flattenHooksList(hooksTree) {
  const hooksList = [];
  flattenHooksListImpl(hooksTree, hooksList);
  return hooksList;
}

function flattenHooksListImpl(hooksTree, hooksList) {
  for (let i = 0; i < hooksTree.length; i += 1) {
    const hook = hooksTree[i];
    if (isUnnamedBuiltInHook(hook)) {
      continue;
    }

    hooksList.push(hook);

    if (Array.isArray(hook.subHooks) && hook.subHooks.length > 0) {
      flattenHooksListImpl(hook.subHooks, hooksList);
    }
  }
}

export async function loadSourceAndMetadata(hooksList, fetchFileWithCaching = null) {
  const locationKeyToHookSourceAndMetadata = initializeHookSourceAndMetadata(hooksList);

  await loadSourceFiles(locationKeyToHookSourceAndMetadata, fetchFileWithCaching);
  await extractAndLoadSourceMapJSON(locationKeyToHookSourceAndMetadata, fetchFileWithCaching);

  return locationKeyToHookSourceAndMetadata;
}

function initializeHookSourceAndMetadata(hooksList) {
  const locationKeyToHookSourceAndMetadata = new Map();

  for (let i = 0; i < hooksList.length; i += 1) {
    const hook = hooksList[i];
    const hookSource = hook.hookSource;

    if (hookSource == null) {
      throw new Error('Hook source code location not found.');
    }

    const locationKey = getHookSourceLocationKey(hookSource);

    if (!locationKeyToHookSourceAndMetadata.has(locationKey)) {
      const runtimeSourceURL = hookSource.fileName;
      locationKeyToHookSourceAndMetadata.set(locationKey, {
        hookSource,
        runtimeSourceCode: null,
        runtimeSourceURL,
        sourceMapJSON: null,
        sourceMapURL: null,
      });
    }
  }

  return locationKeyToHookSourceAndMetadata;
}

async function fetchFile(url, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('Global fetch is unavailable for hook-name source loading.');
  }

  const response = await fetchImpl(url, FETCH_OPTIONS);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }

  return response.text();
}

async function loadSourceFiles(locationKeyToHookSourceAndMetadata, fetchFileWithCaching) {
  const dedupedFetchPromises = new Map();
  const setterPromises = [];

  locationKeyToHookSourceAndMetadata.forEach((hookSourceAndMetadata) => {
    const {runtimeSourceURL} = hookSourceAndMetadata;

    let fetchFileFunction = (url) => fetchFile(url);
    if (typeof fetchFileWithCaching === 'function') {
      fetchFileFunction = fetchFileWithCaching;
    }

    const fetchPromise =
      dedupedFetchPromises.get(runtimeSourceURL) ||
      (runtimeSourceURL && !runtimeSourceURL.startsWith('<anonymous')
        ? fetchFileFunction(runtimeSourceURL).then((runtimeSourceCode) => {
            if (runtimeSourceCode.length > MAX_SOURCE_LENGTH) {
              throw new Error('Source code too large to parse');
            }
            return runtimeSourceCode;
          })
        : Promise.reject(new Error('Empty url')));

    dedupedFetchPromises.set(runtimeSourceURL, fetchPromise);

    setterPromises.push(
      fetchPromise.then((runtimeSourceCode) => {
        hookSourceAndMetadata.runtimeSourceCode = runtimeSourceCode;
      }),
    );
  });

  await Promise.allSettled(setterPromises);
}

function decodeBase64String(encoded) {
  return Buffer.from(encoded, 'base64').toString('utf8');
}

async function extractAndLoadSourceMapJSON(
  locationKeyToHookSourceAndMetadata,
  fetchFileWithCaching,
) {
  const dedupedFetchPromises = new Map();
  const setterPromises = [];

  locationKeyToHookSourceAndMetadata.forEach((hookSourceAndMetadata) => {
    const sourceMapRegex = / ?sourceMappingURL=([^\s'\"]+)/gm;
    const runtimeSourceCode = hookSourceAndMetadata.runtimeSourceCode;

    if (typeof runtimeSourceCode !== 'string' || runtimeSourceCode.length === 0) {
      return;
    }

    let sourceMappingURLMatch = sourceMapRegex.exec(runtimeSourceCode);

    if (sourceMappingURLMatch == null) {
      return;
    }

    const externalSourceMapURLs = [];
    while (sourceMappingURLMatch != null) {
      const {runtimeSourceURL} = hookSourceAndMetadata;
      const sourceMappingURL = sourceMappingURLMatch[1];
      const hasInlineSourceMap = sourceMappingURL.indexOf('base64,') >= 0;

      if (hasInlineSourceMap) {
        try {
          const trimmed = sourceMappingURL.match(/base64,([a-zA-Z0-9+/=]+)/)[1];
          const decoded = decodeBase64String(trimmed);
          const sourceMapJSON = JSON.parse(decoded);

          if (sourceMapIncludesSource(sourceMapJSON, runtimeSourceURL)) {
            hookSourceAndMetadata.sourceMapJSON = sourceMapJSON;
            hookSourceAndMetadata.runtimeSourceCode = null;
            break;
          }
        } catch {
          // Ignore malformed source-map-like strings.
        }
      } else {
        externalSourceMapURLs.push(sourceMappingURL);
      }

      sourceMappingURLMatch = sourceMapRegex.exec(runtimeSourceCode);
    }

    if (hookSourceAndMetadata.sourceMapJSON !== null) {
      return;
    }

    externalSourceMapURLs.forEach((sourceMappingURL, index) => {
      if (index !== externalSourceMapURLs.length - 1) {
        return;
      }

      const {runtimeSourceURL} = hookSourceAndMetadata;
      let url = sourceMappingURL;
      if (!url.startsWith('http') && !url.startsWith('/')) {
        const lastSlashIdx = runtimeSourceURL.lastIndexOf('/');
        if (lastSlashIdx !== -1) {
          const baseURL = runtimeSourceURL.slice(0, runtimeSourceURL.lastIndexOf('/'));
          url = `${baseURL}/${url}`;
        }
      }

      hookSourceAndMetadata.sourceMapURL = url;

      let fetcher = (value) => fetchFile(value);
      if (typeof fetchFileWithCaching === 'function') {
        fetcher = fetchFileWithCaching;
      }

      const fetchPromise =
        dedupedFetchPromises.get(url) ||
        fetcher(url)
          .then((sourceMapContents) => JSON.parse(sourceMapContents))
          .catch(() => null);

      dedupedFetchPromises.set(url, fetchPromise);

      setterPromises.push(
        fetchPromise.then((sourceMapJSON) => {
          if (sourceMapJSON !== null) {
            hookSourceAndMetadata.sourceMapJSON = sourceMapJSON;
            hookSourceAndMetadata.runtimeSourceCode = null;
          }
        }),
      );
    });
  });

  await Promise.allSettled(setterPromises);
}
