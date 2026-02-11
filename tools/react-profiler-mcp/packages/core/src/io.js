import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';

export function resolvePath(cwd, filePath) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('Expected a file path string');
  }
  return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}

export async function readJsonFile(cwd, filePath) {
  const resolvedPath = resolvePath(cwd, filePath);
  const raw = await readFile(resolvedPath, 'utf8');
  try {
    return {resolvedPath, data: JSON.parse(raw)};
  } catch (error) {
    throw new Error(`Failed to parse JSON from ${resolvedPath}: ${error.message}`);
  }
}

export async function writeJsonFile(cwd, filePath, data) {
  const resolvedPath = resolvePath(cwd, filePath);
  const dir = path.dirname(resolvedPath);
  await mkdir(dir, {recursive: true});
  await writeFile(resolvedPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return resolvedPath;
}
