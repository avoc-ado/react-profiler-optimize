/**
 * Vendored/adapted from:
 * react/packages/react-devtools-shared/src/hooks/SourceMapMetadataConsumer.js
 */

import {createRequire} from 'node:module';

import {decodeHookMap} from './generateHookMap.js';
import {getHookNameForLocation} from './getHookNameForLocation.js';

const require = createRequire(import.meta.url);
const util = require('source-map-js/lib/util');

const HOOK_MAP_INDEX_IN_REACT_METADATA = 0;
const REACT_METADATA_INDEX_IN_FB_METADATA = 1;
const REACT_SOURCES_EXTENSION_KEY = 'x_react_sources';
const FB_SOURCES_EXTENSION_KEY = 'x_facebook_sources';

function normalizeSourcePath(sourceInput, map) {
  const sourceRoot = map?.sourceRoot;
  let source = String(sourceInput);

  source = util.normalize(source);

  source =
    sourceRoot != null && util.isAbsolute(sourceRoot) && util.isAbsolute(source)
      ? util.relative(sourceRoot, source)
      : source;

  return util.computeSourceURL(sourceRoot, source);
}

export class SourceMapMetadataConsumer {
  constructor(sourceMap) {
    this._sourceMap = sourceMap;
    this._decodedHookMapCache = new Map();
    this._metadataBySource = null;
  }

  hookNameFor({line, column, source}) {
    if (source == null) {
      return null;
    }

    const hookMap = this._getHookMapForSource(source);
    if (hookMap == null) {
      return null;
    }

    return getHookNameForLocation({line, column}, hookMap);
  }

  hasHookMap(source) {
    if (source == null) {
      return false;
    }

    return this._getHookMapForSource(source) != null;
  }

  _getMetadataBySource() {
    if (this._metadataBySource == null) {
      this._metadataBySource = this._getMetadataObjectsBySourceNames(this._sourceMap);
    }

    return this._metadataBySource;
  }

  _getMetadataObjectsBySourceNames(sourceMap) {
    if (sourceMap?.mappings === undefined && Array.isArray(sourceMap?.sections)) {
      const metadataMap = new Map();
      sourceMap.sections.forEach((section) => {
        const nested = this._getMetadataObjectsBySourceNames(section.map);
        nested.forEach((value, key) => {
          metadataMap.set(key, value);
        });
      });
      return metadataMap;
    }

    const metadataMap = new Map();
    const basicMap = sourceMap;

    const updateMap = (metadata, sourceIndex) => {
      const sourceName = Array.isArray(basicMap.sources) ? basicMap.sources[sourceIndex] : null;
      if (typeof sourceName === 'string') {
        const normalized = normalizeSourcePath(sourceName, basicMap);
        metadataMap.set(normalized, metadata);
      }
    };

    if (
      Object.prototype.hasOwnProperty.call(sourceMap, REACT_SOURCES_EXTENSION_KEY) &&
      sourceMap[REACT_SOURCES_EXTENSION_KEY] != null
    ) {
      const reactMetadataArray = sourceMap[REACT_SOURCES_EXTENSION_KEY];
      reactMetadataArray.filter(Boolean).forEach(updateMap);
    } else if (
      Object.prototype.hasOwnProperty.call(sourceMap, FB_SOURCES_EXTENSION_KEY) &&
      sourceMap[FB_SOURCES_EXTENSION_KEY] != null
    ) {
      const fbMetadataArray = sourceMap[FB_SOURCES_EXTENSION_KEY];
      fbMetadataArray.forEach((fbMetadata, sourceIndex) => {
        const reactMetadata =
          fbMetadata != null ? fbMetadata[REACT_METADATA_INDEX_IN_FB_METADATA] : null;
        if (reactMetadata != null) {
          updateMap(reactMetadata, sourceIndex);
        }
      });
    }

    return metadataMap;
  }

  _getHookMapForSource(source) {
    if (this._decodedHookMapCache.has(source)) {
      return this._decodedHookMapCache.get(source);
    }

    let hookMap = null;
    const metadataBySource = this._getMetadataBySource();
    const normalized = normalizeSourcePath(source, this._sourceMap);
    const metadata = metadataBySource.get(normalized);

    if (metadata != null) {
      const encodedHookMap = metadata[HOOK_MAP_INDEX_IN_REACT_METADATA];
      hookMap = encodedHookMap != null ? decodeHookMap(encodedHookMap) : null;
    }

    if (hookMap != null) {
      this._decodedHookMapCache.set(source, hookMap);
    }

    return hookMap;
  }
}
