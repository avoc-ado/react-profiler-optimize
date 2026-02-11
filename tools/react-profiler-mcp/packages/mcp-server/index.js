#!/usr/bin/env node

import os from 'node:os';
import path from 'node:path';
import {existsSync} from 'node:fs';
import {mkdtemp, readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {recordReactDevToolsProfile} from '@react-profiler-mcp/core';

import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const execFileAsync = promisify(execFile);

function asBoolean(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  throw new Error(`Invalid boolean value: ${String(value)}`);
}

function asNumber(value, fallback, name) {
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric value for ${name}: ${String(value)}`);
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
    path.resolve(moduleDir, '../../../../skills/react-profiler-optimize'),
    path.resolve(process.cwd(), '.skill-edit/react-profiler-optimize'),
    path.resolve(process.cwd(), '../.skill-edit/react-profiler-optimize'),
    path.resolve(process.cwd(), '../../.skill-edit/react-profiler-optimize'),
    path.resolve(moduleDir, '../../../.skill-edit/react-profiler-optimize'),
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

async function parseAnalyzeOutput({stdout, outputPath}) {
  if (typeof outputPath === 'string' && outputPath !== '') {
    const resolved = path.isAbsolute(outputPath)
      ? outputPath
      : path.resolve(process.cwd(), outputPath);
    const raw = await readFile(resolved, 'utf8');
    return JSON.parse(raw);
  }

  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error('Analyze script produced empty stdout');
  }
  return JSON.parse(trimmed);
}

async function parseCompareOutput({stdout, outputPath}) {
  if (typeof outputPath === 'string' && outputPath !== '') {
    const resolved = path.isAbsolute(outputPath)
      ? outputPath
      : path.resolve(process.cwd(), outputPath);
    const raw = await readFile(resolved, 'utf8');
    return JSON.parse(raw);
  }

  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error('Compare script produced empty stdout');
  }
  return JSON.parse(trimmed);
}

const server = new Server(
  {
    name: 'react-profiler-mcp',
    version: '0.2.0',
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'record_react_devtools_profile',
      description:
        'Automate React DevTools profiling for a target URL, then export a React DevTools profile JSON (version 5).',
      inputSchema: {
        type: 'object',
        properties: {
          url: {type: 'string'},
          outputPath: {type: 'string'},
          waitForSelector: {type: 'string'},
          waitForSelectorTimeoutMs: {type: 'number'},
          profileDurationMs: {type: 'number'},
          interactionSteps: {type: 'array'},
          recordChangeDescriptions: {type: 'boolean'},
          recordTimeline: {type: 'boolean'},
          headless: {type: 'boolean'},
          chromePath: {type: 'string'},
          viewportWidth: {type: 'number'},
          viewportHeight: {type: 'number'},
          navigationTimeoutMs: {type: 'number'},
          launchArgs: {type: 'array'},
          inspectElements: {type: 'boolean'},
          inspectElementsMaxPerRoot: {type: 'number'},
          inspectElementsTimeoutMs: {type: 'number'},
          inspectElementsConcurrency: {type: 'number'},
          parseHookNamesEnabled: {type: 'boolean'},
          parseHookNamesTimeoutMs: {type: 'number'},
          parseHookNamesSourceRoots: {type: 'array'},
          parseHookNamesSourceRoot: {type: 'string'},
        },
        required: ['url', 'outputPath'],
      },
    },
    {
      name: 'analyze_profile',
      description:
        'Run the react-profiler-optimize analyze script on a Chrome trace or React DevTools export and return the normalized report.',
      inputSchema: {
        type: 'object',
        properties: {
          inputPath: {type: 'string'},
          outputPath: {type: 'string'},
          sourceRoot: {type: 'string'},
          enableHookNameEnrichment: {type: 'boolean'},
        },
        required: ['inputPath'],
      },
    },
    {
      name: 'compare_profile_reports',
      description:
        'Run the react-profiler-optimize compare script on two analysis report JSON files.',
      inputSchema: {
        type: 'object',
        properties: {
          beforeReportPath: {type: 'string'},
          afterReportPath: {type: 'string'},
          outputPath: {type: 'string'},
        },
        required: ['beforeReportPath', 'afterReportPath'],
      },
    },
    {
      name: 'compare_profiles_end_to_end',
      description:
        'Analyze baseline and optimized profile inputs, then compare them using the skill scripts.',
      inputSchema: {
        type: 'object',
        properties: {
          beforeProfilePath: {type: 'string'},
          afterProfilePath: {type: 'string'},
          outputPath: {type: 'string'},
          sourceRoot: {type: 'string'},
          enableHookNameEnrichment: {type: 'boolean'},
        },
        required: ['beforeProfilePath', 'afterProfilePath'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async request => {
  const {name, arguments: args = {}} = request.params;

  try {
    if (name === 'record_react_devtools_profile') {
      const result = await recordReactDevToolsProfile({
        cwd: process.cwd(),
        url: String(args.url),
        outputPath: String(args.outputPath),
        waitForSelector:
          typeof args.waitForSelector === 'string' ? args.waitForSelector : undefined,
        waitForSelectorTimeoutMs: asNumber(
          args.waitForSelectorTimeoutMs,
          30000,
          'waitForSelectorTimeoutMs',
        ),
        profileDurationMs: asNumber(args.profileDurationMs, 8000, 'profileDurationMs'),
        interactionSteps: Array.isArray(args.interactionSteps) ? args.interactionSteps : [],
        recordChangeDescriptions: asBoolean(args.recordChangeDescriptions, true),
        recordTimeline: asBoolean(args.recordTimeline, false),
        headless: asBoolean(args.headless, true),
        chromePath: typeof args.chromePath === 'string' ? args.chromePath : undefined,
        viewport: {
          width: asNumber(args.viewportWidth, 1440, 'viewportWidth'),
          height: asNumber(args.viewportHeight, 900, 'viewportHeight'),
        },
        navigationTimeoutMs: asNumber(args.navigationTimeoutMs, 60000, 'navigationTimeoutMs'),
        launchArgs: Array.isArray(args.launchArgs)
          ? args.launchArgs.map(value => String(value))
          : [],
        inspectElements: asBoolean(args.inspectElements, true),
        inspectElementsMaxPerRoot: asNumber(
          args.inspectElementsMaxPerRoot,
          1500,
          'inspectElementsMaxPerRoot',
        ),
        inspectElementsTimeoutMs: asNumber(
          args.inspectElementsTimeoutMs,
          4000,
          'inspectElementsTimeoutMs',
        ),
        inspectElementsConcurrency: asNumber(
          args.inspectElementsConcurrency,
          8,
          'inspectElementsConcurrency',
        ),
        parseHookNamesEnabled: asBoolean(args.parseHookNamesEnabled, true),
        parseHookNamesTimeoutMs: asNumber(
          args.parseHookNamesTimeoutMs,
          5000,
          'parseHookNamesTimeoutMs',
        ),
        parseHookNamesSourceRoots: Array.isArray(args.parseHookNamesSourceRoots)
          ? args.parseHookNamesSourceRoots.map(value => String(value))
          : typeof args.parseHookNamesSourceRoot === 'string'
            ? [String(args.parseHookNamesSourceRoot)]
            : [],
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({profile: result}, null, 2),
          },
        ],
      };
    }

    if (name === 'analyze_profile') {
      const scriptPath = getAnalyzeScriptPath();
      const scriptArgs = ['--input', String(args.inputPath)];
      if (args.outputPath) {
        scriptArgs.push('--output', String(args.outputPath));
      }
      if (typeof args.sourceRoot === 'string' && args.sourceRoot.trim() !== '') {
        scriptArgs.push('--source-root', String(args.sourceRoot));
      }
      if (args.enableHookNameEnrichment === false) {
        scriptArgs.push('--no-hook-name-enrichment');
      }

      const {stdout, stderr} = await runNodeScript(scriptPath, scriptArgs);
      const report = await parseAnalyzeOutput({
        stdout,
        outputPath: args.outputPath ? String(args.outputPath) : null,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                report,
                stderrSummary: stderr.trim() || null,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    if (name === 'compare_profile_reports') {
      const scriptPath = getCompareScriptPath();
      const scriptArgs = [
        '--before',
        String(args.beforeReportPath),
        '--after',
        String(args.afterReportPath),
      ];
      if (args.outputPath) {
        scriptArgs.push('--output', String(args.outputPath));
      }

      const {stdout, stderr} = await runNodeScript(scriptPath, scriptArgs);
      const diff = await parseCompareOutput({
        stdout,
        outputPath: args.outputPath ? String(args.outputPath) : null,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                diff,
                stderrSummary: stderr.trim() || null,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    if (name === 'compare_profiles_end_to_end') {
      const analyzeScript = getAnalyzeScriptPath();
      const compareScript = getCompareScriptPath();
      const tempDir = await mkdtemp(path.join(os.tmpdir(), 'react-profiler-mcp-'));
      const beforeReportPath = path.join(tempDir, 'before-report.json');
      const afterReportPath = path.join(tempDir, 'after-report.json');

      const beforeAnalyze = await runNodeScript(analyzeScript, [
        '--input',
        String(args.beforeProfilePath),
        '--output',
        beforeReportPath,
        ...(typeof args.sourceRoot === 'string' && args.sourceRoot.trim() !== ''
          ? ['--source-root', String(args.sourceRoot)]
          : []),
        ...(args.enableHookNameEnrichment === false ? ['--no-hook-name-enrichment'] : []),
      ]);
      const afterAnalyze = await runNodeScript(analyzeScript, [
        '--input',
        String(args.afterProfilePath),
        '--output',
        afterReportPath,
        ...(typeof args.sourceRoot === 'string' && args.sourceRoot.trim() !== ''
          ? ['--source-root', String(args.sourceRoot)]
          : []),
        ...(args.enableHookNameEnrichment === false ? ['--no-hook-name-enrichment'] : []),
      ]);

      const compareArgs = [
        '--before',
        beforeReportPath,
        '--after',
        afterReportPath,
      ];
      if (args.outputPath) {
        compareArgs.push('--output', String(args.outputPath));
      }

      const compareResult = await runNodeScript(compareScript, compareArgs);
      const diff = await parseCompareOutput({
        stdout: compareResult.stdout,
        outputPath: args.outputPath ? String(args.outputPath) : null,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                diff,
                intermediateReports: {
                  beforeReportPath,
                  afterReportPath,
                },
                stderrSummary: [
                  beforeAnalyze.stderr.trim(),
                  afterAnalyze.stderr.trim(),
                  compareResult.stderr.trim(),
                ]
                  .filter(Boolean)
                  .join('\n\n') || null,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${error.message}`,
        },
      ],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
