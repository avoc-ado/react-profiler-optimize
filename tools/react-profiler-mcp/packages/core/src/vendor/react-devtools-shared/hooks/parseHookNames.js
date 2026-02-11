/**
 * Vendored/adapted from:
 * react/packages/react-devtools-shared/src/hooks/parseHookNames/index.js
 */

import {flattenHooksList, loadSourceAndMetadata} from './loadSourceAndMetadata.js';
import {
  parseSourceAndMetadata,
  purgeCachedMetadata as purgeCachedMetadataImpl,
} from './parseSourceAndMetadata.js';

const EMPTY_MAP = new Map();

export async function parseHookNames(
  hooksTree,
  {fetchFileWithCaching = null, timeoutMs = 30000} = {},
) {
  const hooksList = flattenHooksList(Array.isArray(hooksTree) ? hooksTree : []);
  if (hooksList.length === 0) {
    return EMPTY_MAP;
  }

  const work = (async () => {
    const locationKeyToHookSourceAndMetadata = await loadSourceAndMetadata(
      hooksList,
      fetchFileWithCaching,
    );

    return parseSourceAndMetadata(hooksList, locationKeyToHookSourceAndMetadata);
  })();

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return work;
  }

  const timeoutPromise = new Promise((_, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out parsing hook names after ${timeoutMs}ms`));
    }, timeoutMs);

    work.then(
      () => clearTimeout(timeout),
      () => clearTimeout(timeout),
    );
  });

  return Promise.race([work, timeoutPromise]);
}

export function purgeCachedMetadata() {
  purgeCachedMetadataImpl();
}
