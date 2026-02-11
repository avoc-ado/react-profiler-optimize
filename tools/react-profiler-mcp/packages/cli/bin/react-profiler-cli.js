#!/usr/bin/env node

import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {existsSync} from 'node:fs';
import {mkdtemp, readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {recordReactDevToolsProfile} from '@react-profiler-mcp/core';

const execFileAsync = promisify(execFile);

function parseArgs(argv) {
  const positional = [];
  const flags = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) {
      flags[key] = true;
      continue;
    }
    flags[key] = next;
    i += 1;
  }

  return {positional, flags};
}

function assertRequired(flags, name) {
  const value = flags[name];
  if (!value || value === true) {
    throw new Error(`Missing required flag --${name}`);
  }
  return value;
}

function parseBooleanFlag(flags, name, defaultValue) {
  const value = flags[name];
  if (value == null) {
    return defaultValue;
  }
  if (value === true) {
    return true;
  }
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }
  throw new Error(`Invalid boolean for --${name}: ${String(value)}`);
}

function parseNumberFlag(flags, name, defaultValue) {
  const value = flags[name];
  if (value == null || value === true) {
    return defaultValue;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid number for --${name}: ${String(value)}`);
  }
  return parsed;
}

function getCodexHome() {
  if (typeof process.env.CODEX_HOME === 'string' && process.env.CODEX_HOME !== '') {
    return process.env.CODEX_HOME;
  }
  return path.join(os.homedir(), '.codex');
}

function getSkillRoot() {
  const envSkillRoot =
    typeof process.env.REACT_PROFILER_SKILL_ROOT === 'string'
      ? process.env.REACT_PROFILER_SKILL_ROOT
      : null;

  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidateRoots = [
    envSkillRoot,
    path.resolve(process.cwd(), 'skills/react-profiler-optimize'),
    path.resolve(process.cwd(), '../skills/react-profiler-optimize'),
    path.resolve(process.cwd(), '../../skills/react-profiler-optimize'),
    path.resolve(moduleDir, '../../../../../skills/react-profiler-optimize'),
    path.resolve(process.cwd(), '.skill-edit/react-profiler-optimize'),
    path.resolve(process.cwd(), '../.skill-edit/react-profiler-optimize'),
    path.resolve(process.cwd(), '../../.skill-edit/react-profiler-optimize'),
    path.resolve(moduleDir, '../../../../../.skill-edit/react-profiler-optimize'),
    path.resolve(moduleDir, '../../../../.skill-edit/react-profiler-optimize'),
    path.join(getCodexHome(), 'skills', 'react-profiler-optimize'),
  ].filter(Boolean);

  for (const candidateRoot of candidateRoots) {
    const analyzePath = path.join(candidateRoot, 'scripts', 'analyze-profile.mjs');
    const comparePath = path.join(candidateRoot, 'scripts', 'compare-profiles.mjs');
    if (existsSync(analyzePath) && existsSync(comparePath)) {
      return candidateRoot;
    }
  }

  return path.join(getCodexHome(), 'skills', 'react-profiler-optimize');
}

function getAnalyzeScriptPath() {
  return path.join(getSkillRoot(), 'scripts', 'analyze-profile.mjs');
}

function getCompareScriptPath() {
  return path.join(getSkillRoot(), 'scripts', 'compare-profiles.mjs');
}

async function runNodeScript(scriptPath, args) {
  const {stdout, stderr} = await execFileAsync('node', [scriptPath, ...args], {
    cwd: process.cwd(),
    maxBuffer: 20 * 1024 * 1024,
  });
  return {
    stdout: String(stdout || ''),
    stderr: String(stderr || ''),
  };
}

async function readJsonFromStdoutOrFile(stdout, outputPath) {
  if (typeof outputPath === 'string' && outputPath !== '') {
    const resolved = path.isAbsolute(outputPath)
      ? outputPath
      : path.resolve(process.cwd(), outputPath);
    const raw = await readFile(resolved, 'utf8');
    return JSON.parse(raw);
  }

  const trimmed = String(stdout || '').trim();
  if (!trimmed) {
    throw new Error('Script produced empty JSON output');
  }
  return JSON.parse(trimmed);
}

function printUsage() {
  console.log(`Usage:
  react-profiler-cli record-react-devtools --url <http://localhost:3000> --out <profile.json> [--steps-file <steps.json>] [--duration-ms <ms>] [--wait-for-selector <css>] [--record-change-descriptions <true|false>] [--record-timeline <true|false>] [--headless <true|false>] [--chrome-path <path>] [--inspect-elements <true|false>] [--inspect-elements-max <n>] [--inspect-elements-timeout-ms <ms>] [--inspect-elements-concurrency <n>] [--parse-hook-names <true|false>] [--parse-hook-names-timeout-ms <ms>] [--parse-hook-names-source-root <path>] [--parse-hook-names-source-roots <path1,path2,...>]
  react-profiler-cli analyze --input <profile-or-trace.json> [--out <report.json>] [--source-root <repo-root>] [--no-hook-name-enrichment]
  react-profiler-cli compare-reports --before-report <report.json> --after-report <report.json> [--out <diff.json>]
  react-profiler-cli compare-profiles --before-profile <profile-or-trace.json> --after-profile <profile-or-trace.json> [--out <diff.json>] [--source-root <repo-root>] [--no-hook-name-enrichment]`);
}

async function run() {
  const {positional, flags} = parseArgs(process.argv.slice(2));
  const command = positional[0];

  if (!command || flags.help) {
    printUsage();
    process.exit(0);
  }

  if (command === 'record-react-devtools' || command === 'record') {
    const url = assertRequired(flags, 'url');
    const outputPath = assertRequired(flags, 'out');
    const stepsFile = typeof flags['steps-file'] === 'string' ? flags['steps-file'] : null;
    const stepsJson = typeof flags['steps-json'] === 'string' ? flags['steps-json'] : null;

    let interactionSteps = [];
    if (stepsFile) {
      const raw = await readFile(path.resolve(process.cwd(), stepsFile), 'utf8');
      interactionSteps = JSON.parse(raw);
    } else if (stepsJson) {
      interactionSteps = JSON.parse(stepsJson);
    }

    const viewportWidth = parseNumberFlag(flags, 'viewport-width', 1440);
    const viewportHeight = parseNumberFlag(flags, 'viewport-height', 900);
    const launchArgs =
      typeof flags['launch-args'] === 'string'
        ? String(flags['launch-args'])
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean)
        : [];

    const result = await recordReactDevToolsProfile({
      cwd: process.cwd(),
      url: String(url),
      outputPath: String(outputPath),
      waitForSelector:
        typeof flags['wait-for-selector'] === 'string'
          ? String(flags['wait-for-selector'])
          : undefined,
      waitForSelectorTimeoutMs: parseNumberFlag(
        flags,
        'wait-for-selector-timeout-ms',
        30000,
      ),
      profileDurationMs: parseNumberFlag(flags, 'duration-ms', 8000),
      interactionSteps,
      recordChangeDescriptions: parseBooleanFlag(
        flags,
        'record-change-descriptions',
        true,
      ),
      recordTimeline: parseBooleanFlag(flags, 'record-timeline', false),
      headless: parseBooleanFlag(flags, 'headless', true),
      chromePath: typeof flags['chrome-path'] === 'string' ? String(flags['chrome-path']) : undefined,
      viewport: {
        width: viewportWidth,
        height: viewportHeight,
      },
      navigationTimeoutMs: parseNumberFlag(flags, 'navigation-timeout-ms', 60000),
      launchArgs,
      inspectElements: parseBooleanFlag(flags, 'inspect-elements', true),
      inspectElementsMaxPerRoot: parseNumberFlag(
        flags,
        typeof flags['inspect-elements-max'] !== 'undefined'
          ? 'inspect-elements-max'
          : 'inspect-elements-max-per-root',
        1500,
      ),
      inspectElementsTimeoutMs: parseNumberFlag(flags, 'inspect-elements-timeout-ms', 4000),
      inspectElementsConcurrency: parseNumberFlag(flags, 'inspect-elements-concurrency', 8),
      parseHookNamesEnabled: parseBooleanFlag(flags, 'parse-hook-names', true),
      parseHookNamesTimeoutMs: parseNumberFlag(flags, 'parse-hook-names-timeout-ms', 5000),
      parseHookNamesSourceRoots:
        typeof flags['parse-hook-names-source-roots'] === 'string'
          ? String(flags['parse-hook-names-source-roots'])
              .split(',')
              .map((value) => value.trim())
              .filter(Boolean)
          : typeof flags['parse-hook-names-source-root'] === 'string'
            ? [String(flags['parse-hook-names-source-root']).trim()].filter(Boolean)
            : [],
    });

    console.log(JSON.stringify({profile: result}, null, 2));
    return;
  }

  if (command === 'analyze' || command === 'summarize') {
    const inputPath = assertRequired(flags, 'input');
    const outputPath = typeof flags.out === 'string' ? flags.out : undefined;
    const sourceRoot = typeof flags['source-root'] === 'string' ? flags['source-root'] : undefined;
    const disableHookNameEnrichment = flags['no-hook-name-enrichment'] === true;

    const scriptArgs = ['--input', inputPath];
    if (outputPath) {
      scriptArgs.push('--output', outputPath);
    }
    if (sourceRoot) {
      scriptArgs.push('--source-root', sourceRoot);
    }
    if (disableHookNameEnrichment) {
      scriptArgs.push('--no-hook-name-enrichment');
    }

    const {stdout, stderr} = await runNodeScript(getAnalyzeScriptPath(), scriptArgs);
    const report = await readJsonFromStdoutOrFile(stdout, outputPath);

    console.log(
      JSON.stringify(
        {
          report,
          stderrSummary: stderr.trim() || null,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (command === 'compare-reports') {
    const beforeReportPath = assertRequired(flags, 'before-report');
    const afterReportPath = assertRequired(flags, 'after-report');
    const outputPath = typeof flags.out === 'string' ? flags.out : undefined;

    const scriptArgs = ['--before', beforeReportPath, '--after', afterReportPath];
    if (outputPath) {
      scriptArgs.push('--output', outputPath);
    }

    const {stdout, stderr} = await runNodeScript(getCompareScriptPath(), scriptArgs);
    const diff = await readJsonFromStdoutOrFile(stdout, outputPath);

    console.log(
      JSON.stringify(
        {
          diff,
          stderrSummary: stderr.trim() || null,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (command === 'compare-profiles' || command === 'compare') {
    const beforeProfilePath =
      (typeof flags['before-profile'] === 'string' && flags['before-profile']) ||
      (typeof flags.before === 'string' && flags.before) ||
      assertRequired(flags, 'before-profile');
    const afterProfilePath =
      (typeof flags['after-profile'] === 'string' && flags['after-profile']) ||
      (typeof flags.after === 'string' && flags.after) ||
      assertRequired(flags, 'after-profile');
    const outputPath = typeof flags.out === 'string' ? flags.out : undefined;
    const sourceRoot = typeof flags['source-root'] === 'string' ? flags['source-root'] : undefined;
    const disableHookNameEnrichment = flags['no-hook-name-enrichment'] === true;

    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'react-profiler-cli-'));
    const beforeReportPath = path.join(tempDir, 'before-report.json');
    const afterReportPath = path.join(tempDir, 'after-report.json');

    const beforeAnalyzeArgs = ['--input', beforeProfilePath, '--output', beforeReportPath];
    const afterAnalyzeArgs = ['--input', afterProfilePath, '--output', afterReportPath];
    if (sourceRoot) {
      beforeAnalyzeArgs.push('--source-root', sourceRoot);
      afterAnalyzeArgs.push('--source-root', sourceRoot);
    }
    if (disableHookNameEnrichment) {
      beforeAnalyzeArgs.push('--no-hook-name-enrichment');
      afterAnalyzeArgs.push('--no-hook-name-enrichment');
    }

    const beforeAnalyze = await runNodeScript(getAnalyzeScriptPath(), beforeAnalyzeArgs);
    const afterAnalyze = await runNodeScript(getAnalyzeScriptPath(), afterAnalyzeArgs);

    const compareArgs = ['--before', beforeReportPath, '--after', afterReportPath];
    if (outputPath) {
      compareArgs.push('--output', outputPath);
    }
    const compareResult = await runNodeScript(getCompareScriptPath(), compareArgs);
    const diff = await readJsonFromStdoutOrFile(compareResult.stdout, outputPath);

    console.log(
      JSON.stringify(
        {
          diff,
          intermediateReports: {
            beforeReportPath,
            afterReportPath,
          },
          stderrSummary: [beforeAnalyze.stderr, afterAnalyze.stderr, compareResult.stderr]
            .map((text) => text.trim())
            .filter(Boolean)
            .join('\n\n') || null,
        },
        null,
        2,
      ),
    );
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

run().catch(error => {
  console.error(error.message);
  process.exit(1);
});
