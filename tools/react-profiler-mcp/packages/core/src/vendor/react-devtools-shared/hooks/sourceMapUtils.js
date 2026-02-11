/**
 * Vendored/adapted from:
 * react/packages/react-devtools-shared/src/hooks/SourceMapUtils.js
 */

export function sourceMapIncludesSource(sourceMap, source) {
  if (source == null) {
    return false;
  }

  if (sourceMap?.mappings === undefined && Array.isArray(sourceMap?.sections)) {
    return sourceMap.sections.some((section) => sourceMapIncludesSource(section.map, source));
  }

  const sources = Array.isArray(sourceMap?.sources) ? sourceMap.sources : [];
  return sources.some((entry) => entry === 'Inline Babel script' || source.endsWith(entry));
}
