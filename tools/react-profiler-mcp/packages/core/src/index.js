import {compareSummaries} from './compare.js';
import {readJsonFile, writeJsonFile} from './io.js';
import {recordReactDevToolsProfile} from './react-devtools-recorder.js';
import {summarizeDevToolsProfile} from './summarize.js';

export async function summarizeProfileFile({cwd, profilePath, outputPath}) {
  const {resolvedPath, data} = await readJsonFile(cwd, profilePath);
  const summary = summarizeDevToolsProfile(data, {sourcePath: resolvedPath});

  let writtenTo = null;
  if (outputPath) {
    writtenTo = await writeJsonFile(cwd, outputPath, summary);
  }

  return {summary, writtenTo};
}

export async function compareProfileFiles({
  cwd,
  beforeProfilePath,
  afterProfilePath,
  outputPath,
}) {
  const before = await summarizeProfileFile({
    cwd,
    profilePath: beforeProfilePath,
  });
  const after = await summarizeProfileFile({
    cwd,
    profilePath: afterProfilePath,
  });

  const comparison = compareSummaries(before.summary, after.summary);

  let writtenTo = null;
  if (outputPath) {
    writtenTo = await writeJsonFile(cwd, outputPath, comparison);
  }

  return {
    comparison,
    writtenTo,
    beforeSummary: before.summary,
    afterSummary: after.summary,
  };
}

export {recordReactDevToolsProfile};
