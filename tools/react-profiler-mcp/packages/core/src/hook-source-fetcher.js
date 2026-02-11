import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

function stripJsonComments(input) {
  let output = '';
  let inString = false;
  let stringQuote = null;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    const next = input[i + 1];

    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false;
        output += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === stringQuote) {
        inString = false;
        stringQuote = null;
      }
      continue;
    }

    if ((char === '"' || char === "'") && !inString) {
      inString = true;
      stringQuote = char;
      output += char;
      continue;
    }

    if (char === '/' && next === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }

    if (char === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }

    output += char;
  }

  return output;
}

function parseJsoncFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(stripJsonComments(raw));
  } catch {
    return null;
  }
}

function normalizePathSlashes(value) {
  return value.replace(/\\/g, '/');
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function pathExistsAsFile(value) {
  try {
    return fs.statSync(value).isFile();
  } catch {
    return false;
  }
}

function pathExistsAsDirectory(value) {
  try {
    return fs.statSync(value).isDirectory();
  } catch {
    return false;
  }
}

function resolveExistingFile(candidatePath) {
  if (!candidatePath || typeof candidatePath !== 'string') {
    return null;
  }

  const normalized = path.normalize(candidatePath);

  if (pathExistsAsFile(normalized)) {
    return normalized;
  }

  const ext = path.extname(normalized);
  if (!ext) {
    for (const sourceExt of SOURCE_EXTENSIONS) {
      const withExt = `${normalized}${sourceExt}`;
      if (pathExistsAsFile(withExt)) {
        return withExt;
      }
    }
  }

  if (pathExistsAsDirectory(normalized)) {
    for (const sourceExt of SOURCE_EXTENSIONS) {
      const indexPath = path.join(normalized, `index${sourceExt}`);
      if (pathExistsAsFile(indexPath)) {
        return indexPath;
      }
    }
  }

  return null;
}

function dedupeValues(values) {
  return [...new Set(values.filter(Boolean))];
}

function parseAliasPattern(pattern) {
  const wildcardIndex = pattern.indexOf('*');
  if (wildcardIndex === -1) {
    return {
      hasWildcard: false,
      prefix: pattern,
      suffix: '',
    };
  }

  return {
    hasWildcard: true,
    prefix: pattern.slice(0, wildcardIndex),
    suffix: pattern.slice(wildcardIndex + 1),
  };
}

function loadAliasEntriesForRoot(root) {
  const configCandidates = [
    path.join(root, 'tsconfig.json'),
    path.join(root, 'jsconfig.json'),
  ];

  const entries = [];

  for (const configPath of configCandidates) {
    if (!pathExistsAsFile(configPath)) {
      continue;
    }

    const parsed = parseJsoncFile(configPath);
    if (!parsed || typeof parsed !== 'object') {
      continue;
    }

    const compilerOptions =
      parsed.compilerOptions && typeof parsed.compilerOptions === 'object'
        ? parsed.compilerOptions
        : {};

    const baseUrl =
      typeof compilerOptions.baseUrl === 'string' && compilerOptions.baseUrl.trim()
        ? path.resolve(path.dirname(configPath), compilerOptions.baseUrl)
        : root;

    const paths =
      compilerOptions.paths && typeof compilerOptions.paths === 'object'
        ? compilerOptions.paths
        : {};

    for (const [aliasPattern, targetListRaw] of Object.entries(paths)) {
      const targetList = Array.isArray(targetListRaw) ? targetListRaw : [targetListRaw];
      const alias = parseAliasPattern(String(aliasPattern));

      for (const targetTemplateRaw of targetList) {
        if (typeof targetTemplateRaw !== 'string' || targetTemplateRaw.trim() === '') {
          continue;
        }

        const targetTemplate = String(targetTemplateRaw);
        const target = parseAliasPattern(targetTemplate);

        entries.push({
          aliasPattern: String(aliasPattern),
          targetTemplate,
          aliasHasWildcard: alias.hasWildcard,
          aliasPrefix: alias.prefix,
          aliasSuffix: alias.suffix,
          targetHasWildcard: target.hasWildcard,
          targetPrefix: target.prefix,
          targetSuffix: target.suffix,
          baseUrl,
          configPath,
        });
      }
    }
  }

  return entries;
}

function resolveAliasSpecifier(specifier, rootConfig) {
  const out = [];

  for (const entry of rootConfig.aliasEntries) {
    if (!entry.aliasHasWildcard) {
      if (specifier === entry.aliasPrefix) {
        out.push(path.resolve(entry.baseUrl, entry.targetPrefix));
      }
      continue;
    }

    if (!specifier.startsWith(entry.aliasPrefix) || !specifier.endsWith(entry.aliasSuffix)) {
      continue;
    }

    const wildcardValue = specifier.slice(
      entry.aliasPrefix.length,
      specifier.length - entry.aliasSuffix.length,
    );

    if (entry.targetHasWildcard) {
      out.push(path.resolve(entry.baseUrl, `${entry.targetPrefix}${wildcardValue}${entry.targetSuffix}`));
    } else {
      out.push(path.resolve(entry.baseUrl, entry.targetPrefix));
    }
  }

  if (specifier.startsWith('@/')) {
    out.push(path.join(rootConfig.root, 'src', specifier.slice(2)));
  }

  return dedupeValues(out);
}

function sanitizeRuntimeSourceURL(rawUrl) {
  const value = String(rawUrl || '').trim();
  if (!value) {
    return '';
  }

  const withoutHash = value.split('#')[0];
  const withoutQuery = withoutHash.split('?')[0];
  return safeDecode(withoutQuery);
}

function normalizeWebpackSpecifier(specifier) {
  const normalized = normalizePathSlashes(specifier);
  const variants = [normalized];

  const prefixes = [
    'webpack-internal:///(app-pages-browser)/',
    'webpack-internal:///(',
    'webpack-internal:///',
    'webpack://_N_E/',
    'webpack:///(',
    'webpack:///',
    'webpack://',
  ];

  for (const prefix of prefixes) {
    if (!normalized.startsWith(prefix)) {
      continue;
    }

    let rest = normalized.slice(prefix.length);
    if (prefix.endsWith('/(')) {
      const end = rest.indexOf(')/');
      if (end !== -1) {
        rest = rest.slice(end + 2);
      }
    }

    variants.push(rest);
  }

  const expanded = [];
  for (const variant of variants) {
    let value = variant;

    value = value.replace(/^\(.*?\)\//, '');
    value = value.replace(/^\.?\//, '');

    expanded.push(value);

    const dotSlashIndex = value.indexOf('/./');
    if (dotSlashIndex >= 0 && dotSlashIndex + 3 < value.length) {
      expanded.push(value.slice(dotSlashIndex + 3));
    }

    const nodeModulesMarker = '/node_modules/';
    const nodeModulesIndex = value.indexOf(nodeModulesMarker);
    if (nodeModulesIndex >= 0) {
      expanded.push(value.slice(nodeModulesIndex + 1));
    }
  }

  return dedupeValues(expanded.map((value) => value.trim()));
}

function gatherCandidateSpecifiers(url) {
  const sanitized = sanitizeRuntimeSourceURL(url);
  if (!sanitized) {
    return [];
  }

  if (sanitized.startsWith('file://')) {
    try {
      return [fileURLToPath(sanitized)];
    } catch {
      return [];
    }
  }

  if (sanitized.startsWith('http://') || sanitized.startsWith('https://')) {
    return [sanitized];
  }

  return dedupeValues(normalizeWebpackSpecifier(sanitized));
}

function getHttpPathname(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return safeDecode(parsed.pathname || '');
  } catch {
    return '';
  }
}

function createHttpLocalPathCandidates(rawUrl, rootConfig) {
  const pathname = getHttpPathname(rawUrl);
  if (!pathname || !rootConfig || !rootConfig.root) {
    return [];
  }

  const normalized = normalizePathSlashes(pathname);
  const trimmed = normalized.replace(/^\/+/, '');
  const candidates = [];

  if (trimmed) {
    candidates.push(path.join(rootConfig.root, trimmed));
  }

  if (normalized.startsWith('/_next/')) {
    const nextRelative = normalized.slice('/_next/'.length);
    candidates.push(path.join(rootConfig.root, '.next', nextRelative));
  }

  if (normalized.startsWith('/static/')) {
    candidates.push(path.join(rootConfig.root, 'public', normalized.slice('/static/'.length)));
  }

  if (normalized.startsWith('/_next/static/')) {
    const staticRelative = normalized.slice('/_next/static/'.length);
    candidates.push(path.join(rootConfig.root, '.next', 'static', staticRelative));
    candidates.push(path.join(rootConfig.root, '.next', 'dev', 'static', staticRelative));
  }

  return dedupeValues(candidates);
}

function createRootConfig(rootPath) {
  return {
    root: rootPath,
    aliasEntries: loadAliasEntriesForRoot(rootPath),
  };
}

function createLocalPathCandidates(specifier, rootConfig) {
  if (!specifier || typeof specifier !== 'string') {
    return [];
  }

  const normalized = normalizePathSlashes(specifier);
  const candidates = [];

  if (path.isAbsolute(normalized)) {
    candidates.push(normalized);
  } else {
    candidates.push(path.join(rootConfig.root, normalized.replace(/^\.\//, '')));

    if (normalized.startsWith('./') || normalized.startsWith('../')) {
      candidates.push(path.resolve(rootConfig.root, normalized));
    }

    if (normalized.startsWith('node_modules/')) {
      candidates.push(path.join(rootConfig.root, normalized));
    }

    const nodeModulesMarker = '/node_modules/';
    const nodeModulesIndex = normalized.indexOf(nodeModulesMarker);
    if (nodeModulesIndex >= 0) {
      candidates.push(path.join(rootConfig.root, normalized.slice(nodeModulesIndex + 1)));
    }

    const aliasCandidates = resolveAliasSpecifier(normalized, rootConfig);
    candidates.push(...aliasCandidates);
  }

  return dedupeValues(candidates);
}

function normalizeSourceRoots({cwd, sourceRoots}) {
  const inputRoots = [];

  if (Array.isArray(sourceRoots)) {
    inputRoots.push(...sourceRoots);
  } else if (typeof sourceRoots === 'string' && sourceRoots.trim()) {
    inputRoots.push(...sourceRoots.split(',').map((value) => value.trim()));
  }

  inputRoots.push(cwd);

  const resolved = dedupeValues(
    inputRoots
      .filter((value) => typeof value === 'string' && value.trim())
      .map((value) => path.resolve(cwd, value)),
  ).filter((value) => pathExistsAsDirectory(value));

  return resolved;
}

async function fetchNetworkText(url) {
  if (typeof fetch !== 'function') {
    throw new Error('Global fetch is unavailable');
  }

  const response = await fetch(url, {cache: 'force-cache'});
  if (!response.ok) {
    throw new Error(`Network fetch failed for ${url}: ${response.status}`);
  }

  return response.text();
}

export function createHookSourceFetcher({cwd = process.cwd(), sourceRoots = []} = {}) {
  const resolvedRoots = normalizeSourceRoots({cwd, sourceRoots});
  const rootConfigs = resolvedRoots.map((rootPath) => createRootConfig(rootPath));

  const contentCache = new Map();

  const pushLog = (fetchLog, entry) => {
    if (Array.isArray(fetchLog)) {
      fetchLog.push(entry);
    }
  };

  const fetchWithDiagnostics = async (url, fetchLog = []) => {
    const normalizedUrl = sanitizeRuntimeSourceURL(url);

    if (contentCache.has(normalizedUrl)) {
      const cached = contentCache.get(normalizedUrl);
      pushLog(fetchLog, {
        url: normalizedUrl,
        status: cached.success ? 'cache-hit' : 'cache-error',
        resolver: cached.resolver,
        resolvedPath: cached.resolvedPath ?? null,
        error: cached.error ?? null,
      });

      if (cached.success) {
        return cached.content;
      }
      throw new Error(cached.error || `Failed to resolve ${normalizedUrl}`);
    }

    const specifiers = gatherCandidateSpecifiers(normalizedUrl);

    for (const specifier of specifiers) {
      if (!specifier.startsWith('http://') && !specifier.startsWith('https://')) {
        continue;
      }

      for (const rootConfig of rootConfigs) {
        const candidatePaths = createHttpLocalPathCandidates(specifier, rootConfig);
        for (const candidatePath of candidatePaths) {
          const resolvedPath = resolveExistingFile(candidatePath);
          if (!resolvedPath) {
            continue;
          }

          try {
            const content = fs.readFileSync(resolvedPath, 'utf8');
            const record = {
              success: true,
              resolver: 'local-file-http-rewrite',
              resolvedPath,
              content,
            };
            contentCache.set(normalizedUrl, record);
            pushLog(fetchLog, {
              url: normalizedUrl,
              status: 'success',
              resolver: 'local-file-http-rewrite',
              resolvedPath,
              sourceRoot: rootConfig.root,
            });
            return content;
          } catch (error) {
            const message = String(error?.message ?? error);
            contentCache.set(normalizedUrl, {
              success: false,
              resolver: 'local-file-http-rewrite',
              resolvedPath,
              error: message,
            });
            pushLog(fetchLog, {
              url: normalizedUrl,
              status: 'error',
              resolver: 'local-file-http-rewrite',
              resolvedPath,
              sourceRoot: rootConfig.root,
              error: message,
            });
            throw new Error(message);
          }
        }
      }
    }

    for (const specifier of specifiers) {
      if (specifier.startsWith('http://') || specifier.startsWith('https://')) {
        continue;
      }

      for (const rootConfig of rootConfigs) {
        const candidatePaths = createLocalPathCandidates(specifier, rootConfig);

        for (const candidatePath of candidatePaths) {
          const resolvedPath = resolveExistingFile(candidatePath);
          if (!resolvedPath) {
            continue;
          }

          try {
            const content = fs.readFileSync(resolvedPath, 'utf8');
            const record = {
              success: true,
              resolver: 'local-file',
              resolvedPath,
              content,
            };
            contentCache.set(normalizedUrl, record);
            pushLog(fetchLog, {
              url: normalizedUrl,
              status: 'success',
              resolver: 'local-file',
              resolvedPath,
              sourceRoot: rootConfig.root,
            });
            return content;
          } catch (error) {
            const message = String(error?.message ?? error);
            contentCache.set(normalizedUrl, {
              success: false,
              resolver: 'local-file',
              resolvedPath,
              error: message,
            });
            pushLog(fetchLog, {
              url: normalizedUrl,
              status: 'error',
              resolver: 'local-file',
              resolvedPath,
              sourceRoot: rootConfig.root,
              error: message,
            });
            throw new Error(message);
          }
        }
      }
    }

    if (normalizedUrl.startsWith('http://') || normalizedUrl.startsWith('https://')) {
      try {
        const content = await fetchNetworkText(normalizedUrl);
        contentCache.set(normalizedUrl, {
          success: true,
          resolver: 'network-fetch',
          resolvedPath: null,
          content,
        });
        pushLog(fetchLog, {
          url: normalizedUrl,
          status: 'success',
          resolver: 'network-fetch',
          resolvedPath: null,
        });
        return content;
      } catch (error) {
        const message = String(error?.message ?? error);
        contentCache.set(normalizedUrl, {
          success: false,
          resolver: 'network-fetch',
          resolvedPath: null,
          error: message,
        });
        pushLog(fetchLog, {
          url: normalizedUrl,
          status: 'error',
          resolver: 'network-fetch',
          resolvedPath: null,
          error: message,
        });
        throw new Error(message);
      }
    }

    const error = `Unable to resolve hook source URL: ${normalizedUrl}`;
    contentCache.set(normalizedUrl, {
      success: false,
      resolver: 'unresolved',
      resolvedPath: null,
      error,
    });
    pushLog(fetchLog, {
      url: normalizedUrl,
      status: 'error',
      resolver: 'unresolved',
      resolvedPath: null,
      error,
    });
    throw new Error(error);
  };

  return {
    fetchWithDiagnostics,
    getSourceRoots() {
      return [...resolvedRoots];
    },
    getAliasSummary() {
      return rootConfigs.map((config) => ({
        sourceRoot: config.root,
        aliasPatternCount: config.aliasEntries.length,
        aliasPatterns: dedupeValues(config.aliasEntries.map((entry) => entry.aliasPattern)).slice(0, 25),
      }));
    },
  };
}
