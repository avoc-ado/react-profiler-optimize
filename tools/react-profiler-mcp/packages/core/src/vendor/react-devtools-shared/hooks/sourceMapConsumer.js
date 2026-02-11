/**
 * Vendored/adapted from:
 * react/packages/react-devtools-shared/src/hooks/SourceMapConsumer.js
 */

import {decode} from '@jridgewell/sourcemap-codec';

export default function createSourceMapConsumer(sourceMapJSON) {
  if (Array.isArray(sourceMapJSON?.sections)) {
    return createIndexedSourceMapConsumer(sourceMapJSON);
  }
  return createBasicSourceMapConsumer(sourceMapJSON);
}

function createBasicSourceMapConsumer(sourceMapJSON) {
  const decodedMappings = decode(sourceMapJSON.mappings);

  function originalPositionFor({columnNumber, lineNumber}) {
    const targetColumnNumber = columnNumber - 1;

    const lineMappings = decodedMappings[lineNumber - 1];
    if (!Array.isArray(lineMappings) || lineMappings.length === 0) {
      throw new Error(
        `Could not find runtime location for line:${lineNumber} and column:${columnNumber}`,
      );
    }

    let nearestEntry = null;
    let startIndex = 0;
    let stopIndex = lineMappings.length - 1;
    let index = -1;

    while (startIndex <= stopIndex) {
      index = Math.floor((stopIndex + startIndex) / 2);
      nearestEntry = lineMappings[index];

      const currentColumn = nearestEntry[0];
      if (currentColumn === targetColumnNumber) {
        break;
      }

      if (currentColumn > targetColumnNumber) {
        if (stopIndex - index > 0) {
          stopIndex = index;
        } else {
          index = stopIndex;
          break;
        }
      } else if (index - startIndex > 0) {
        startIndex = index;
      } else {
        index = startIndex;
        break;
      }
    }

    while (index > 0) {
      const previousEntry = lineMappings[index - 1];
      if (previousEntry[0] !== targetColumnNumber) {
        break;
      }
      index -= 1;
    }

    if (nearestEntry == null) {
      throw new Error(
        `Could not find runtime location for line:${lineNumber} and column:${columnNumber}`,
      );
    }

    const sourceIndex = nearestEntry[1];
    const sourceContent =
      Array.isArray(sourceMapJSON.sourcesContent) ? sourceMapJSON.sourcesContent[sourceIndex] : null;
    const sourceURL = Array.isArray(sourceMapJSON.sources) ? sourceMapJSON.sources[sourceIndex] : null;
    const line = nearestEntry[2] + 1;
    const column = nearestEntry[3];
    const ignored =
      Array.isArray(sourceMapJSON.ignoreList) && sourceMapJSON.ignoreList.includes(sourceIndex);

    return {
      column,
      line,
      sourceContent: typeof sourceContent === 'string' ? sourceContent : null,
      sourceURL: typeof sourceURL === 'string' ? sourceURL : null,
      ignored,
    };
  }

  return {originalPositionFor};
}

function createIndexedSourceMapConsumer(sourceMapJSON) {
  let lastOffset = {
    line: -1,
    column: 0,
  };

  const sections = sourceMapJSON.sections.map((section) => {
    const offsetLine0 = section.offset.line;
    const offsetColumn0 = section.offset.column;

    if (
      offsetLine0 < lastOffset.line ||
      (offsetLine0 === lastOffset.line && offsetColumn0 < lastOffset.column)
    ) {
      throw new Error('Section offsets must be ordered and non-overlapping.');
    }

    lastOffset = section.offset;

    return {
      offsetLine0,
      offsetColumn0,
      map: section.map,
      sourceMapConsumer: null,
    };
  });

  function originalPositionFor({columnNumber, lineNumber}) {
    const column0 = columnNumber - 1;
    const line0 = lineNumber - 1;

    let left = 0;
    let right = sections.length - 1;
    let section = null;

    while (left <= right) {
      const middle = ~~((left + right) / 2);
      const currentSection = sections[middle];

      if (
        currentSection.offsetLine0 < line0 ||
        (currentSection.offsetLine0 === line0 && currentSection.offsetColumn0 <= column0)
      ) {
        section = currentSection;
        left = middle + 1;
      } else {
        right = middle - 1;
      }
    }

    if (section == null) {
      throw new Error(
        `Could not find matching section for line:${lineNumber} and column:${columnNumber}`,
      );
    }

    if (section.sourceMapConsumer === null) {
      section.sourceMapConsumer = createSourceMapConsumer(section.map);
    }

    return section.sourceMapConsumer.originalPositionFor({
      columnNumber: columnNumber - section.offsetColumn0,
      lineNumber: lineNumber - section.offsetLine0,
    });
  }

  return {originalPositionFor};
}
