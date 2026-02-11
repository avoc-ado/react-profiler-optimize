/**
 * Vendored/adapted from:
 * react/packages/react-devtools-shared/src/hookSourceLocation.js
 */

export function getHookSourceLocationKey(hookSource) {
  if (!hookSource || typeof hookSource !== 'object') {
    throw new Error('Hook source code location not found.');
  }

  const fileName =
    typeof hookSource.fileName === 'string' && hookSource.fileName.trim()
      ? hookSource.fileName
      : null;
  const lineNumber =
    Number.isFinite(hookSource.lineNumber) ? Number(hookSource.lineNumber) : null;
  const columnNumber =
    Number.isFinite(hookSource.columnNumber) ? Number(hookSource.columnNumber) : null;

  if (fileName == null || lineNumber == null || columnNumber == null) {
    throw new Error('Hook source code location not found.');
  }

  return `${fileName}:${lineNumber}:${columnNumber}`;
}
