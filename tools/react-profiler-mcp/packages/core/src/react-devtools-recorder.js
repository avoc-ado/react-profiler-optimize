import {createServer} from 'node:http';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';

import puppeteer from 'puppeteer-core';
import {WebSocketServer} from 'ws';

import {createHookSourceFetcher} from './hook-source-fetcher.js';
import {resolvePath} from './io.js';
import {parseHookNames} from './vendor/react-devtools-shared/hooks/parseHookNames.js';
import {getHookSourceLocationKey} from './vendor/react-devtools-shared/hooks/hookSourceLocation.js';

const require = createRequire(import.meta.url);

const ELEMENT_TYPE_ROOT = 11;

const TREE_OPERATION_ADD = 1;
const TREE_OPERATION_REMOVE = 2;
const TREE_OPERATION_REORDER_CHILDREN = 3;
const TREE_OPERATION_UPDATE_TREE_BASE_DURATION = 4;
const TREE_OPERATION_UPDATE_ERRORS_OR_WARNINGS = 5;
const TREE_OPERATION_SET_SUBTREE_MODE = 7;
const SUSPENSE_TREE_OPERATION_ADD = 8;
const SUSPENSE_TREE_OPERATION_REMOVE = 9;
const SUSPENSE_TREE_OPERATION_REORDER_CHILDREN = 10;
const SUSPENSE_TREE_OPERATION_RESIZE = 11;
const SUSPENSE_TREE_OPERATION_SUSPENDERS = 12;
const TREE_OPERATION_APPLIED_ACTIVITY_SLICE_CHANGE = 13;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

async function runWithConcurrency(items, concurrency, worker) {
  const safeItems = Array.isArray(items) ? items : [];
  if (safeItems.length === 0) {
    return;
  }

  const safeConcurrency = Math.max(
    1,
    Number.isFinite(concurrency) ? Math.floor(concurrency) : 1,
  );
  const workerCount = Math.min(safeItems.length, safeConcurrency);

  let nextIndex = 0;

  const workers = Array.from({length: workerCount}, async () => {
    while (nextIndex < safeItems.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      await worker(safeItems[currentIndex], currentIndex);
    }
  });

  await Promise.all(workers);
}

function parseElementDisplayNameFromBackend(displayName, type) {
  if (displayName == null) {
    return {
      formattedDisplayName: null,
      hocDisplayNames: null,
      compiledWithForget: false,
    };
  }

  if (displayName.startsWith('Forget(') && displayName.endsWith(')')) {
    const inner = displayName.slice(7, displayName.length - 1);
    const parsed = parseElementDisplayNameFromBackend(inner, type);
    return {
      formattedDisplayName: parsed.formattedDisplayName,
      hocDisplayNames: parsed.hocDisplayNames,
      compiledWithForget: true,
    };
  }

  let formattedDisplayName = displayName;
  let hocDisplayNames = null;

  if ([1, 5, 6, 8, 15].includes(type) && displayName.includes('(')) {
    const matches = displayName.match(/[^()]+/g);
    if (Array.isArray(matches) && matches.length > 0) {
      formattedDisplayName = matches[matches.length - 1] ?? displayName;
      hocDisplayNames = matches.length > 1 ? matches.slice(0, -1) : null;
    }
  }

  return {
    formattedDisplayName,
    hocDisplayNames,
    compiledWithForget: false,
  };
}

function decodeStringTableEntry(operations, startIndex, length) {
  let text = '';
  for (let i = 0; i < length; i += 1) {
    const codePoint = Number(operations[startIndex + i]);
    if (!Number.isFinite(codePoint)) continue;
    text += String.fromCodePoint(codePoint);
  }
  return text;
}

function getOrCreateRootTree(liveTreesByRoot, rootID) {
  let tree = liveTreesByRoot.get(rootID);
  if (!tree) {
    tree = {
      rootID,
      nodes: new Map(),
    };
    liveTreesByRoot.set(rootID, tree);
  }
  return tree;
}

function applyOperationsToLiveTree({liveTreesByRoot, operations}) {
  if (!Array.isArray(operations) || operations.length < 3) {
    return;
  }

  const rootID = Number(operations[1]);
  if (!Number.isFinite(rootID)) {
    return;
  }

  const tree = getOrCreateRootTree(liveTreesByRoot, rootID);
  const nodes = tree.nodes;

  let i = 2;

  const stringTable = [null];
  const stringTableSize = Number(operations[i++]);
  if (!Number.isFinite(stringTableSize) || stringTableSize < 0) {
    return;
  }

  const stringTableEnd = Math.min(operations.length, i + stringTableSize);
  while (i < stringTableEnd) {
    const nextLength = Number(operations[i++]);
    if (!Number.isFinite(nextLength) || nextLength < 0 || i + nextLength > operations.length) {
      return;
    }
    stringTable.push(decodeStringTableEntry(operations, i, nextLength));
    i += nextLength;
  }

  while (i < operations.length) {
    const operation = Number(operations[i]);

    switch (operation) {
      case TREE_OPERATION_ADD: {
        const id = Number(operations[i + 1]);
        const type = Number(operations[i + 2]);
        i += 3;

        if (!Number.isFinite(id)) {
          break;
        }

        if (type === ELEMENT_TYPE_ROOT) {
          i += 4;
          nodes.set(id, {
            id,
            parentID: 0,
            children: [],
            displayName: null,
            hocDisplayNames: null,
            key: null,
            type,
            compiledWithForget: false,
          });
          tree.rootID = id;
          break;
        }

        const parentID = Number(operations[i]);
        i += 1;
        i += 1; // ownerID

        const displayNameStringID = Number(operations[i]);
        i += 1;

        const keyStringID = Number(operations[i]);
        i += 1;

        i += 1; // name prop string ID

        const rawDisplayName =
          typeof stringTable[displayNameStringID] === 'string'
            ? stringTable[displayNameStringID]
            : null;
        const {formattedDisplayName, hocDisplayNames, compiledWithForget} =
          parseElementDisplayNameFromBackend(rawDisplayName, type);

        const existing = nodes.get(id);
        if (existing && Number.isFinite(existing.parentID)) {
          const oldParent = nodes.get(existing.parentID);
          if (oldParent) {
            oldParent.children = oldParent.children.filter((childID) => childID !== id);
          }
        }

        const parentNode = nodes.get(parentID);
        if (parentNode && !parentNode.children.includes(id)) {
          parentNode.children = parentNode.children.concat(id);
        }

        nodes.set(id, {
          id,
          parentID: Number.isFinite(parentID) ? parentID : 0,
          children: existing?.children ?? [],
          displayName: formattedDisplayName,
          hocDisplayNames,
          key: stringTable[keyStringID] ?? null,
          type: Number.isFinite(type) ? type : null,
          compiledWithForget,
        });
        break;
      }
      case TREE_OPERATION_REMOVE: {
        const removeLength = Number(operations[i + 1]);
        i += 2;

        if (!Number.isFinite(removeLength) || removeLength < 0) {
          break;
        }

        for (let removeIndex = 0; removeIndex < removeLength && i < operations.length; removeIndex += 1) {
          const id = Number(operations[i++]);
          if (!Number.isFinite(id)) continue;

          const node = nodes.get(id);
          if (!node) continue;

          const parentNode = nodes.get(node.parentID);
          if (parentNode) {
            parentNode.children = parentNode.children.filter((childID) => childID !== id);
          }
          nodes.delete(id);
        }
        break;
      }
      case TREE_OPERATION_REORDER_CHILDREN: {
        const id = Number(operations[i + 1]);
        const numChildren = Number(operations[i + 2]);
        i += 3;

        if (!Number.isFinite(numChildren) || numChildren < 0) {
          break;
        }

        const children = [];
        for (let childIndex = 0; childIndex < numChildren && i < operations.length; childIndex += 1) {
          const childID = Number(operations[i++]);
          if (Number.isFinite(childID)) {
            children.push(childID);
          }
        }

        const node = nodes.get(id);
        if (node) {
          node.children = children;
          for (const childID of children) {
            const childNode = nodes.get(childID);
            if (childNode) {
              childNode.parentID = id;
            }
          }
        }
        break;
      }
      case TREE_OPERATION_SET_SUBTREE_MODE: {
        i += 3;
        break;
      }
      case TREE_OPERATION_UPDATE_TREE_BASE_DURATION: {
        i += 3;
        break;
      }
      case TREE_OPERATION_UPDATE_ERRORS_OR_WARNINGS: {
        i += 4;
        break;
      }
      case SUSPENSE_TREE_OPERATION_ADD: {
        const numRects = Number(operations[i + 5]);
        i += 6 + (numRects === -1 ? 0 : Math.max(0, numRects) * 4);
        break;
      }
      case SUSPENSE_TREE_OPERATION_REMOVE: {
        const removeLength = Number(operations[i + 1]);
        i += 2 + (Number.isFinite(removeLength) && removeLength > 0 ? removeLength : 0);
        break;
      }
      case SUSPENSE_TREE_OPERATION_REORDER_CHILDREN: {
        const numChildren = Number(operations[i + 2]);
        i += 3 + (Number.isFinite(numChildren) && numChildren > 0 ? numChildren : 0);
        break;
      }
      case SUSPENSE_TREE_OPERATION_RESIZE: {
        const numRects = Number(operations[i + 2]);
        i += 3 + (numRects === -1 ? 0 : Math.max(0, numRects) * 4);
        break;
      }
      case SUSPENSE_TREE_OPERATION_SUSPENDERS: {
        i += 1;
        const changeLength = Number(operations[i++]);
        const safeLength = Number.isFinite(changeLength) && changeLength > 0 ? changeLength : 0;
        for (let index = 0; index < safeLength && i < operations.length; index += 1) {
          i += 4;
          const environmentNamesLength = Number(operations[i++]);
          i += Number.isFinite(environmentNamesLength) && environmentNamesLength > 0 ? environmentNamesLength : 0;
        }
        break;
      }
      case TREE_OPERATION_APPLIED_ACTIVITY_SLICE_CHANGE: {
        i += 2;
        break;
      }
      default: {
        i += 1;
      }
    }
  }
}

function serializeSnapshotTree(tree) {
  if (!tree || !(tree.nodes instanceof Map)) {
    return [];
  }

  return [...tree.nodes.values()]
    .map((node) => [
      node.id,
      {
        id: node.id,
        children: [...(node.children ?? [])],
        displayName: node.displayName ?? null,
        hocDisplayNames: Array.isArray(node.hocDisplayNames) ? [...node.hocDisplayNames] : null,
        key: node.key ?? null,
        type: Number.isFinite(node.type) ? node.type : 9,
        compiledWithForget: node.compiledWithForget === true,
      },
    ])
    .sort((a, b) => a[0] - b[0]);
}

class BridgeController {
  constructor() {
    this._server = null;
    this._wss = null;
    this._socket = null;
    this._eventListeners = new Map();
    this._waiters = [];
  }

  async start() {
    const httpServer = createServer((_, res) => {
      res.statusCode = 404;
      res.end('React DevTools bridge endpoint');
    });

    await new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(0, '127.0.0.1', () => resolve());
    });

    const address = httpServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to start local WebSocket server');
    }

    const wss = new WebSocketServer({server: httpServer, maxPayload: 1e9});
    wss.on('connection', (socket) => {
      this._socket = socket;
      socket.on('message', (buffer) => {
        let parsed;
        try {
          parsed = JSON.parse(String(buffer));
        } catch {
          return;
        }

        if (!parsed || typeof parsed.event !== 'string') {
          return;
        }
        this._dispatchEvent(parsed.event, parsed.payload);
      });

      socket.on('close', () => {
        if (this._socket === socket) {
          this._socket = null;
        }
      });
    });

    this._server = httpServer;
    this._wss = wss;
    return {port: address.port};
  }

  addListener(eventName, listener) {
    const listeners = this._eventListeners.get(eventName) ?? [];
    listeners.push(listener);
    this._eventListeners.set(eventName, listeners);

    return () => {
      const current = this._eventListeners.get(eventName) ?? [];
      const index = current.indexOf(listener);
      if (index >= 0) {
        current.splice(index, 1);
      }
      this._eventListeners.set(eventName, current);
    };
  }

  waitForEvent(eventName, {timeoutMs = 10000, predicate = null} = {}) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._waiters = this._waiters.filter((waiter) => waiter !== entry);
        reject(new Error(`Timed out waiting for bridge event "${eventName}"`));
      }, timeoutMs);

      const entry = {
        eventName,
        predicate,
        resolve: (payload) => {
          clearTimeout(timeout);
          resolve(payload);
        },
      };

      this._waiters.push(entry);
    });
  }

  send(event, payload) {
    if (!this._socket || this._socket.readyState !== 1) {
      throw new Error(`Cannot send bridge event "${event}" because socket is not connected`);
    }

    this._socket.send(JSON.stringify({event, payload}));
  }

  _dispatchEvent(eventName, payload) {
    const listeners = this._eventListeners.get(eventName) ?? [];
    for (const listener of listeners) {
      try {
        listener(payload);
      } catch {
        // Ignore listener errors to avoid breaking message stream.
      }
    }

    const remaining = [];
    for (const waiter of this._waiters) {
      if (waiter.eventName !== eventName) {
        remaining.push(waiter);
        continue;
      }

      if (typeof waiter.predicate === 'function' && !waiter.predicate(payload)) {
        remaining.push(waiter);
        continue;
      }

      waiter.resolve(payload);
    }
    this._waiters = remaining;
  }

  async close() {
    const closeTasks = [];
    if (this._socket) {
      const socket = this._socket;
      this._socket = null;
      closeTasks.push(
        new Promise((resolve) => {
          socket.once('close', resolve);
          try {
            socket.close();
          } catch {
            resolve();
          }
        }),
      );
    }

    if (this._wss) {
      const wss = this._wss;
      this._wss = null;
      closeTasks.push(
        new Promise((resolve) => {
          wss.close(() => resolve());
        }),
      );
    }

    if (this._server) {
      const server = this._server;
      this._server = null;
      closeTasks.push(
        new Promise((resolve) => {
          server.close(() => resolve());
        }),
      );
    }

    await Promise.allSettled(closeTasks);
  }
}

function resolveChromePath(explicitPath) {
  const candidates = [
    explicitPath,
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      require('node:fs').accessSync(candidate);
      return candidate;
    } catch {
      // Try next candidate.
    }
  }

  throw new Error('Chrome executable not found. Pass --chrome-path or set CHROME_PATH.');
}

async function loadBackendScriptSource() {
  const entryPath = require.resolve('react-devtools-core/backend');
  const entrySource = await readFile(entryPath, 'utf8');

  const wrapperMatch = entrySource.match(/require\(['"](.+)['"]\)/);
  if (!wrapperMatch) {
    return entrySource;
  }

  const requiredPath = wrapperMatch[1];
  const resolvedDistPath = path.resolve(path.dirname(entryPath), requiredPath);
  const distPath = resolvedDistPath.endsWith('.js')
    ? resolvedDistPath
    : `${resolvedDistPath}.js`;
  return readFile(distPath, 'utf8');
}

async function runInteractionStep(page, step) {
  const action = step?.action;

  switch (action) {
    case 'wait': {
      const ms = Number(step.ms ?? step.durationMs ?? 0);
      await sleep(ms);
      return;
    }
    case 'waitForSelector': {
      await page.waitForSelector(String(step.selector), {
        timeout: Number(step.timeoutMs ?? 30000),
      });
      return;
    }
    case 'click': {
      await page.click(String(step.selector));
      return;
    }
    case 'clickText': {
      const selector = typeof step.selector === 'string' ? step.selector : 'button';
      const text = String(step.text ?? '');
      await page.evaluate(
        ({selectorArg, textArg}) => {
          const candidates = Array.from(document.querySelectorAll(selectorArg));
          const target = candidates.find((element) => {
            const content = (element.textContent || '').trim();
            return content === textArg || content.includes(textArg);
          });
          if (!target) {
            throw new Error(`No element matched text \"${textArg}\" for selector \"${selectorArg}\"`);
          }
          target.click();
        },
        {selectorArg: selector, textArg: text},
      );
      return;
    }
    case 'type': {
      const selector = String(step.selector);
      const text = String(step.text ?? '');
      const delay = Number(step.delayMs ?? step.delay ?? 0);
      if (step.clear === true) {
        await page.click(selector, {clickCount: 3});
        await page.keyboard.press('Backspace');
      }
      await page.type(selector, text, {delay});
      return;
    }
    case 'press': {
      await page.keyboard.press(String(step.key));
      return;
    }
    case 'navigate': {
      await page.goto(String(step.url), {
        waitUntil: typeof step.waitUntil === 'string' ? step.waitUntil : 'networkidle2',
        timeout: Number(step.timeoutMs ?? 60000),
      });
      return;
    }
    case 'evaluate': {
      const expression = String(step.expression ?? '');
      await page.evaluate(expression);
      return;
    }
    default:
      throw new Error(`Unsupported interaction step action: ${String(action)}`);
  }
}

async function runInteractionSteps(page, steps = []) {
  if (!Array.isArray(steps)) {
    throw new Error('Interaction steps must be an array');
  }

  for (const step of steps) {
    const repeat = Math.max(1, Number(step?.repeat ?? 1));
    for (let index = 0; index < repeat; index += 1) {
      await runInteractionStep(page, step);
    }
  }
}

function createInjectionScript({backendScriptSource, host, port}) {
  const initializeSnippet = `\n;(function(){\n  if (window.__REACT_DEVTOOLS_AUTOMATION_CONNECTED__) { return; }\n  window.__REACT_DEVTOOLS_AUTOMATION_CONNECTED__ = true;\n  ReactDevToolsBackend.initialize(undefined, false, undefined, undefined);\n  ReactDevToolsBackend.connectToDevTools({host: ${JSON.stringify(host)}, port: ${port}, useHttps: false, retryConnectionDelay: 250});\n})();`;
  return `${backendScriptSource}\n${initializeSnippet}`;
}

function captureSnapshotsAtProfilingStart(liveTreesByRoot) {
  const snapshotsByRoot = new Map();
  for (const [rootID, tree] of liveTreesByRoot.entries()) {
    snapshotsByRoot.set(rootID, serializeSnapshotTree(tree));
  }
  return snapshotsByRoot;
}

function normalizePairEntries(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const pairs = [];
  for (let i = 0; i < value.length; i += 1) {
    const item = value[i];

    if (Array.isArray(item) && item.length >= 2) {
      const key = Number(item[0]);
      if (Number.isFinite(key)) {
        pairs.push([key, item[1]]);
      }
      continue;
    }

    if (Number.isFinite(Number(item)) && Number.isFinite(Number(value[i + 1]))) {
      pairs.push([Number(item), Number(value[i + 1])]);
      i += 1;
    }
  }

  return pairs;
}

function collectCandidateFiberIDsForRoot(root) {
  const candidates = new Set();

  const commitData = Array.isArray(root?.commitData) ? root.commitData : [];
  for (const commit of commitData) {
    for (const [fiberID] of normalizePairEntries(commit?.changeDescriptions)) {
      candidates.add(fiberID);
    }
    for (const [fiberID] of normalizePairEntries(commit?.fiberActualDurations)) {
      candidates.add(fiberID);
    }
    for (const [fiberID] of normalizePairEntries(commit?.fiberSelfDurations)) {
      candidates.add(fiberID);
    }

    const updaters = Array.isArray(commit?.updaters) ? commit.updaters : [];
    for (const updater of updaters) {
      const updaterID = Number(updater?.id);
      if (Number.isFinite(updaterID)) {
        candidates.add(updaterID);
      }
    }
  }

  return [...candidates].sort((a, b) => a - b);
}

function normalizeHookSource(hookSource) {
  if (!hookSource || typeof hookSource !== 'object') {
    return null;
  }

  const fileName =
    typeof hookSource.fileName === 'string' && hookSource.fileName.trim()
      ? hookSource.fileName
      : null;

  if (!fileName) {
    return null;
  }

  return {
    fileName,
    lineNumber: Number.isFinite(hookSource.lineNumber) ? Number(hookSource.lineNumber) : null,
    columnNumber: Number.isFinite(hookSource.columnNumber) ? Number(hookSource.columnNumber) : null,
    functionName:
      typeof hookSource.functionName === 'string' && hookSource.functionName.trim()
        ? hookSource.functionName
        : null,
  };
}

function normalizePrimitiveHookName(rawName) {
  if (typeof rawName !== 'string' || rawName.trim() === '') {
    return null;
  }

  const name = rawName.trim();
  if (/Context$/.test(name)) {
    return 'useContext';
  }
  const map = {
    state: 'useState',
    reducer: 'useReducer',
    ref: 'useRef',
    effect: 'useEffect',
    layouteffect: 'useLayoutEffect',
    insertioneffect: 'useInsertionEffect',
    imperativehandle: 'useImperativeHandle',
    callback: 'useCallback',
    memo: 'useMemo',
    context: 'useContext',
    transition: 'useTransition',
    deferredvalue: 'useDeferredValue',
    syncexternalstore: 'useSyncExternalStore',
    id: 'useId',
    debugvalue: 'useDebugValue',
    optimistic: 'useOptimistic',
    actionstate: 'useActionState',
    formstate: 'useActionState',
    use: 'use',
  };

  const normalizedKey = name.toLowerCase().replace(/\s+/g, '');
  return map[normalizedKey] ?? (name.startsWith('use') ? name : `use${name}`);
}

function extractHooksData(inspectedElementValue) {
  const hooksContainer = inspectedElementValue?.hooks;
  if (!hooksContainer || typeof hooksContainer !== 'object') {
    return null;
  }

  const candidate =
    hooksContainer && typeof hooksContainer === 'object' && 'data' in hooksContainer
      ? hooksContainer.data
      : hooksContainer;

  if (!Array.isArray(candidate)) {
    return null;
  }

  return candidate;
}

function normalizeHookTreeNode(node) {
  if (!node || typeof node !== 'object') {
    return null;
  }

  const id = Number.isFinite(node.id) ? Number(node.id) : null;
  const name = typeof node.name === 'string' && node.name.trim() ? node.name.trim() : null;
  const hookSource = normalizeHookSource(node.hookSource);

  const subHooks = Array.isArray(node.subHooks)
    ? node.subHooks
        .map((subHook) => normalizeHookTreeNode(subHook))
        .filter((subHook) => subHook !== null)
    : [];

  return {
    id,
    name,
    hookSource,
    subHooks,
  };
}

function extractNormalizedHooksTree(inspectedElementValue) {
  const hooksData = extractHooksData(inspectedElementValue);
  if (!hooksData) {
    return [];
  }

  return hooksData
    .map((hookNode) => normalizeHookTreeNode(hookNode))
    .filter((hookNode) => hookNode !== null);
}

function extractHookSlotsFromHooksTree(hooksTree) {
  const slotsByIndex = new Map();

  const visitNode = (node, customHookPath) => {
    if (!node || typeof node !== 'object') {
      return;
    }

    const id = Number(node.id);
    const name = typeof node.name === 'string' && node.name.trim() ? node.name.trim() : null;

    if (Number.isFinite(id) && !slotsByIndex.has(id)) {
      slotsByIndex.set(id, {
        index: id,
        primitiveHook: normalizePrimitiveHookName(name),
        primitiveNameRaw: name,
        customHookPath,
        hookSource: normalizeHookSource(node.hookSource),
        parsedHookName: null,
        parsedHookNameSource: null,
      });
    }

    const nextCustomPath =
      !Number.isFinite(id) && name ? customHookPath.concat(name) : customHookPath;

    if (Array.isArray(node.subHooks)) {
      for (const subHook of node.subHooks) {
        visitNode(subHook, nextCustomPath);
      }
    }
  };

  for (const hookNode of hooksTree) {
    visitNode(hookNode, []);
  }

  return [...slotsByIndex.values()].sort((a, b) => a.index - b.index);
}

function extractHookSlots(inspectedElementValue) {
  return extractHookSlotsFromHooksTree(extractNormalizedHooksTree(inspectedElementValue));
}

function normalizeParsedHookNamesMap(parsedHookNamesMap) {
  if (!(parsedHookNamesMap instanceof Map)) {
    return null;
  }

  const normalized = Object.create(null);
  let entryCount = 0;
  for (const [key, value] of parsedHookNamesMap.entries()) {
    if (typeof key !== 'string' || key.length === 0) {
      continue;
    }
    if (typeof value === 'string' && value.trim()) {
      normalized[key] = value.trim();
      entryCount += 1;
      continue;
    }
    if (value == null) {
      normalized[key] = null;
      entryCount += 1;
    }
  }

  return entryCount > 0 ? normalized : null;
}

function collectHookSourceLocationKeys(hooksTree) {
  const keys = [];
  const sourceUrls = new Set();

  const visitNode = (node) => {
    if (!node || typeof node !== 'object') {
      return;
    }

    if (node.hookSource && typeof node.hookSource === 'object') {
      try {
        keys.push(getHookSourceLocationKey(node.hookSource));
      } catch {
        // Ignore malformed hook source entries.
      }

      if (typeof node.hookSource.fileName === 'string' && node.hookSource.fileName.trim()) {
        sourceUrls.add(node.hookSource.fileName.trim());
      }
    }

    if (Array.isArray(node.subHooks)) {
      for (const subHook of node.subHooks) {
        visitNode(subHook);
      }
    }
  };

  for (const hookNode of hooksTree) {
    visitNode(hookNode);
  }

  return {
    locationKeys: [...new Set(keys)],
    sourceUrls: [...sourceUrls],
  };
}

function summarizeHookNameParsingDiagnostics({
  fetchLog,
  hookNamesBySourceLocation,
  hooksTree,
  timedOut,
  errorMessage,
}) {
  const {locationKeys, sourceUrls} = collectHookSourceLocationKeys(hooksTree);
  const resolvedLocationCount =
    hookNamesBySourceLocation == null
      ? 0
      : Object.entries(hookNamesBySourceLocation).filter(
          ([, value]) => typeof value === 'string' && value.trim(),
        ).length;

  const unresolvedLocationKeys =
    hookNamesBySourceLocation == null
      ? locationKeys
      : locationKeys.filter((key) => hookNamesBySourceLocation[key] == null);

  const fetchSummary = {
    total: Array.isArray(fetchLog) ? fetchLog.length : 0,
    success: 0,
    cacheHit: 0,
    error: 0,
    byResolver: {
      'local-file': 0,
      'network-fetch': 0,
      unresolved: 0,
      unknown: 0,
    },
  };

  for (const entry of Array.isArray(fetchLog) ? fetchLog : []) {
    const resolver =
      typeof entry?.resolver === 'string' && entry.resolver.trim()
        ? entry.resolver
        : 'unknown';
    if (!(resolver in fetchSummary.byResolver)) {
      fetchSummary.byResolver[resolver] = 0;
    }
    fetchSummary.byResolver[resolver] += 1;

    const status = entry?.status;
    if (status === 'success') {
      fetchSummary.success += 1;
    } else if (status === 'cache-hit' || status === 'cache-error') {
      fetchSummary.cacheHit += 1;
      if (status === 'cache-error') {
        fetchSummary.error += 1;
      }
    } else if (status === 'error') {
      fetchSummary.error += 1;
    }
  }

  return {
    attempted: true,
    timedOut: timedOut === true,
    errorMessage: errorMessage ?? null,
    sourceUrlCount: sourceUrls.length,
    sourceUrls: sourceUrls.slice(0, 25),
    locationCount: locationKeys.length,
    resolvedLocationCount,
    unresolvedLocationCount: unresolvedLocationKeys.length,
    unresolvedLocationKeys: unresolvedLocationKeys.slice(0, 25),
    fetchSummary,
  };
}

async function parseHookNamesForHooksTree({hooksTree, timeoutMs, hookSourceFetcher}) {
  if (!Array.isArray(hooksTree) || hooksTree.length === 0) {
    return {
      hookNamesBySourceLocation: null,
      errorMessage: null,
      timedOut: false,
      diagnostics: {
        attempted: false,
        timedOut: false,
        errorMessage: null,
        sourceUrlCount: 0,
        sourceUrls: [],
        locationCount: 0,
        resolvedLocationCount: 0,
        unresolvedLocationCount: 0,
        unresolvedLocationKeys: [],
        fetchSummary: {
          total: 0,
          success: 0,
          cacheHit: 0,
          error: 0,
          byResolver: {},
        },
      },
    };
  }

  const fetchLog = [];

  try {
    const parsedHookNamesMap = await parseHookNames(hooksTree, {
      timeoutMs,
      fetchFileWithCaching:
        hookSourceFetcher && typeof hookSourceFetcher.fetchWithDiagnostics === 'function'
          ? (sourceUrl) => hookSourceFetcher.fetchWithDiagnostics(sourceUrl, fetchLog)
          : null,
    });
    const hookNamesBySourceLocation = normalizeParsedHookNamesMap(parsedHookNamesMap);
    return {
      hookNamesBySourceLocation,
      errorMessage: null,
      timedOut: false,
      diagnostics: summarizeHookNameParsingDiagnostics({
        fetchLog,
        hookNamesBySourceLocation,
        hooksTree,
        timedOut: false,
        errorMessage: null,
      }),
    };
  } catch (error) {
    const message = String(error?.message ?? error);
    const timedOut = message.includes('Timed out parsing hook names');
    return {
      hookNamesBySourceLocation: null,
      errorMessage: message,
      timedOut,
      diagnostics: summarizeHookNameParsingDiagnostics({
        fetchLog,
        hookNamesBySourceLocation: null,
        hooksTree,
        timedOut,
        errorMessage: message,
      }),
    };
  }
}

function applyParsedHookNamesToHookSlots({hookSlots, hookNamesBySourceLocation}) {
  if (!Array.isArray(hookSlots) || !hookNamesBySourceLocation) {
    return {
      resolvedSlotCount: 0,
      touchedSlotCount: 0,
    };
  }

  let resolvedSlotCount = 0;
  let touchedSlotCount = 0;

  for (const slot of hookSlots) {
    if (!slot || typeof slot !== 'object' || !slot.hookSource) {
      continue;
    }

    let locationKey = null;
    try {
      locationKey = getHookSourceLocationKey(slot.hookSource);
    } catch {
      locationKey = null;
    }

    if (!locationKey || !(locationKey in hookNamesBySourceLocation)) {
      continue;
    }

    touchedSlotCount += 1;
    const parsedName = hookNamesBySourceLocation[locationKey];
    slot.parsedHookName = typeof parsedName === 'string' && parsedName.trim() ? parsedName : null;
    slot.parsedHookNameSource = 'parseHookNames';
    if (slot.parsedHookName) {
      resolvedSlotCount += 1;
    }
  }

  return {
    resolvedSlotCount,
    touchedSlotCount,
  };
}

function normalizeSourceLocation(source) {
  if (Array.isArray(source)) {
    const [fileName, lineNumber, columnNumber] = source;
    if (typeof fileName === 'string' && fileName.trim()) {
      return {
        fileName,
        lineNumber: Number.isFinite(lineNumber) ? Number(lineNumber) : null,
        columnNumber: Number.isFinite(columnNumber) ? Number(columnNumber) : null,
      };
    }
    return null;
  }

  if (!source || typeof source !== 'object') {
    return null;
  }

  if (typeof source.fileName !== 'string' || !source.fileName.trim()) {
    return null;
  }

  return {
    fileName: source.fileName,
    lineNumber: Number.isFinite(source.lineNumber) ? Number(source.lineNumber) : null,
    columnNumber: Number.isFinite(source.columnNumber) ? Number(source.columnNumber) : null,
  };
}

function normalizeOwners(owners) {
  if (!Array.isArray(owners)) {
    return [];
  }

  return owners
    .map((owner) => ({
      id: Number.isFinite(owner?.id) ? Number(owner.id) : null,
      displayName:
        typeof owner?.displayName === 'string' && owner.displayName.trim()
          ? owner.displayName
          : null,
      type: Number.isFinite(owner?.type) ? Number(owner.type) : null,
      key: owner?.key ?? null,
    }))
    .filter((owner) => owner.id !== null || owner.displayName !== null);
}

function summarizeInspectedElementValue(value) {
  const hooksTree = extractNormalizedHooksTree(value);
  return {
    source: normalizeSourceLocation(value?.source),
    stack: value?.stack ?? null,
    env: typeof value?.env === 'string' ? value.env : null,
    rootType: typeof value?.rootType === 'string' ? value.rootType : null,
    rendererPackageName:
      typeof value?.rendererPackageName === 'string' ? value.rendererPackageName : null,
    rendererVersion:
      typeof value?.rendererVersion === 'string' ? value.rendererVersion : null,
    owners: normalizeOwners(value?.owners),
    hooksTree,
    hookSlots: extractHookSlotsFromHooksTree(hooksTree),
    hookNamesBySourceLocation: null,
  };
}

async function inspectElement(bridge, {rendererID, fiberID, requestID, timeoutMs}) {
  bridge.send('inspectElement', {
    forceFullData: true,
    id: fiberID,
    path: null,
    rendererID,
    requestID,
  });

  const payload = await bridge.waitForEvent('inspectedElement', {
    timeoutMs,
    predicate: (eventPayload) => Number(eventPayload?.responseID) === requestID,
  });
  return payload;
}

async function captureInspectedElementsEnrichment({
  bridge,
  dataForRoots,
  rootToRenderer,
  enabled,
  maxFibersPerRoot,
  timeoutMs,
  inspectConcurrency,
  parseHookNamesEnabled,
  parseHookNamesTimeoutMs,
  hookSourceFetcher,
}) {
  if (enabled !== true) {
    return {
      enabled: false,
      roots: [],
      totals: {
        requested: 0,
        captured: 0,
        timedOut: 0,
        errors: 0,
      },
      hookNameParsing: {
        enabled: false,
        timeoutMs: Number.isFinite(parseHookNamesTimeoutMs) ? Number(parseHookNamesTimeoutMs) : null,
        requestedElements: 0,
        parsedElements: 0,
        parsedElementsWithNamedHooks: 0,
        resolvedSlots: 0,
        touchedSlots: 0,
        timedOutElements: 0,
        failedElements: 0,
        unresolvedLocationCount: 0,
      },
    };
  }

  let requestID = 1;
  const roots = [];
  let totalRequested = 0;
  let totalCaptured = 0;
  let totalTimedOut = 0;
  let totalErrors = 0;
  let parseRequestedElements = 0;
  let parseElements = 0;
  let parseElementsWithNamedHooks = 0;
  let parseResolvedSlots = 0;
  let parseTouchedSlots = 0;
  let parseTimedOutElements = 0;
  let parseFailedElements = 0;
  let parseUnresolvedLocationCount = 0;

  for (const root of dataForRoots) {
    const rootID = Number(root?.rootID);
    const rendererID = rootToRenderer.get(rootID);
    const candidates = collectCandidateFiberIDsForRoot(root);
    const limitedCandidates = Number.isFinite(maxFibersPerRoot)
      ? candidates.slice(0, Math.max(0, Number(maxFibersPerRoot)))
      : candidates;

    if (!Number.isFinite(rendererID)) {
      roots.push({
        rootID: Number.isFinite(rootID) ? rootID : null,
        rendererID: null,
        inspectedCount: 0,
        requestedCount: limitedCandidates.length,
        skippedReason: 'missing-renderer-id',
        elements: [],
      });
      totalRequested += limitedCandidates.length;
      continue;
    }

    const elements = new Array(limitedCandidates.length);
    let inspectedCount = 0;
    totalRequested += limitedCandidates.length;

    await runWithConcurrency(limitedCandidates, inspectConcurrency, async (fiberID, index) => {
      try {
        const payload = await inspectElement(bridge, {
          rendererID,
          fiberID,
          requestID: requestID++,
          timeoutMs,
        });

        const status = typeof payload?.type === 'string' ? payload.type : 'unknown';
        if (status === 'full-data' && payload?.value && typeof payload.value === 'object') {
          const summary = summarizeInspectedElementValue(payload.value);
          if (parseHookNamesEnabled === true && Array.isArray(summary.hooksTree) && summary.hooksTree.length > 0) {
            parseRequestedElements += 1;
            const parseOutcome = await parseHookNamesForHooksTree({
              hooksTree: summary.hooksTree,
              timeoutMs: parseHookNamesTimeoutMs,
              hookSourceFetcher,
            });
            parseElements += 1;
            summary.hookNameParsing = parseOutcome.diagnostics ?? null;
            if (parseOutcome?.diagnostics?.unresolvedLocationCount) {
              parseUnresolvedLocationCount += Number(parseOutcome.diagnostics.unresolvedLocationCount);
            }

            if (parseOutcome.hookNamesBySourceLocation) {
              summary.hookNamesBySourceLocation = parseOutcome.hookNamesBySourceLocation;
              const slotOutcome = applyParsedHookNamesToHookSlots({
                hookSlots: summary.hookSlots,
                hookNamesBySourceLocation: summary.hookNamesBySourceLocation,
              });
              parseResolvedSlots += slotOutcome.resolvedSlotCount;
              parseTouchedSlots += slotOutcome.touchedSlotCount;
              if (slotOutcome.resolvedSlotCount > 0) {
                parseElementsWithNamedHooks += 1;
              }
            } else if (parseOutcome.timedOut) {
              parseTimedOutElements += 1;
            } else if (parseOutcome.errorMessage) {
              parseFailedElements += 1;
            }
          }
          delete summary.hooksTree;
          elements[index] = {
            fiberID,
            status,
            ...summary,
          };
          inspectedCount += 1;
          totalCaptured += 1;
        } else {
          elements[index] = {
            fiberID,
            status,
          };
          if (status === 'error') {
            totalErrors += 1;
          }
        }
      } catch (error) {
        const message = String(error?.message ?? error);
        const timedOut = message.includes('Timed out waiting for bridge event');
        elements[index] = {
          fiberID,
          status: timedOut ? 'timeout' : 'error',
          errorMessage: message,
        };
        if (timedOut) {
          totalTimedOut += 1;
        } else {
          totalErrors += 1;
        }
      }
    });

    roots.push({
      rootID: Number.isFinite(rootID) ? rootID : null,
      rendererID,
      inspectedCount,
      requestedCount: limitedCandidates.length,
      skippedReason: null,
      elements: elements.filter(Boolean),
    });
  }

  return {
    enabled: true,
    maxFibersPerRoot: Number.isFinite(maxFibersPerRoot) ? Number(maxFibersPerRoot) : null,
    inspectTimeoutMs: Number.isFinite(timeoutMs) ? Number(timeoutMs) : null,
    roots,
    totals: {
      requested: totalRequested,
      captured: totalCaptured,
      timedOut: totalTimedOut,
      errors: totalErrors,
    },
    hookNameParsing: {
      enabled: parseHookNamesEnabled === true,
      timeoutMs: Number.isFinite(parseHookNamesTimeoutMs) ? Number(parseHookNamesTimeoutMs) : null,
      requestedElements: parseRequestedElements,
      parsedElements: parseElements,
      parsedElementsWithNamedHooks: parseElementsWithNamedHooks,
      resolvedSlots: parseResolvedSlots,
      touchedSlots: parseTouchedSlots,
      timedOutElements: parseTimedOutElements,
      failedElements: parseFailedElements,
      unresolvedLocationCount: parseUnresolvedLocationCount,
    },
  };
}

export async function recordReactDevToolsProfile({
  cwd = process.cwd(),
  url,
  outputPath,
  waitForSelector,
  waitForSelectorTimeoutMs = 30000,
  profileDurationMs = 8000,
  interactionSteps = [],
  recordChangeDescriptions = true,
  recordTimeline = false,
  headless = true,
  chromePath,
  viewport = {width: 1440, height: 900},
  navigationTimeoutMs = 60000,
  launchArgs = [],
  inspectElements = true,
  inspectElementsMaxPerRoot = 1500,
  inspectElementsTimeoutMs = 4000,
  inspectElementsConcurrency = 8,
  parseHookNamesEnabled = true,
  parseHookNamesTimeoutMs = 5000,
  parseHookNamesSourceRoots = [],
}) {
  if (typeof url !== 'string' || url.length === 0) {
    throw new Error('recordReactDevToolsProfile requires a non-empty url');
  }

  if (typeof outputPath !== 'string' || outputPath.length === 0) {
    throw new Error('recordReactDevToolsProfile requires outputPath');
  }

  const bridge = new BridgeController();
  const liveTreesByRoot = new Map();
  const rendererIDs = new Set();
  const rootToRenderer = new Map();

  let profilingActive = false;
  let snapshotsByRoot = new Map();
  let operationsDuringProfilingByRoot = new Map();
  const hookSourceFetcher = createHookSourceFetcher({
    cwd,
    sourceRoots: parseHookNamesSourceRoots,
  });

  bridge.addListener('operations', (operations) => {
    if (!Array.isArray(operations) || operations.length < 2) {
      return;
    }

    const rendererID = Number(operations[0]);
    const rootID = Number(operations[1]);

    if (Number.isFinite(rendererID)) {
      rendererIDs.add(rendererID);
    }
    if (Number.isFinite(rootID) && Number.isFinite(rendererID)) {
      rootToRenderer.set(rootID, rendererID);
    }

    applyOperationsToLiveTree({liveTreesByRoot, operations});

    if (profilingActive && Number.isFinite(rootID)) {
      const list = operationsDuringProfilingByRoot.get(rootID) ?? [];
      list.push([...operations]);
      operationsDuringProfilingByRoot.set(rootID, list);
    }
  });

  const {port} = await bridge.start();

  const browser = await puppeteer.launch({
    executablePath: resolveChromePath(chromePath),
    headless,
    args: ['--no-sandbox', '--disable-dev-shm-usage', ...launchArgs],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport(viewport);

    const backendScriptSource = await loadBackendScriptSource();
    await page.evaluateOnNewDocument(
      createInjectionScript({
        backendScriptSource,
        host: '127.0.0.1',
        port,
      }),
    );

    const backendInitializedPromise = bridge.waitForEvent('backendInitialized', {
      timeoutMs: navigationTimeoutMs,
    });

    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: navigationTimeoutMs,
    });

    await backendInitializedPromise;

    if (typeof waitForSelector === 'string' && waitForSelector.length > 0) {
      await page.waitForSelector(waitForSelector, {
        timeout: waitForSelectorTimeoutMs,
      });
    }

    snapshotsByRoot = captureSnapshotsAtProfilingStart(liveTreesByRoot);
    operationsDuringProfilingByRoot = new Map(
      [...snapshotsByRoot.keys()].map((rootID) => [rootID, []]),
    );

    profilingActive = true;
    bridge.send('startProfiling', {
      recordChangeDescriptions: recordChangeDescriptions === true,
      recordTimeline: recordTimeline === true,
    });

    try {
      await bridge.waitForEvent('profilingStatus', {
        timeoutMs: 5000,
        predicate: (payload) => payload === true,
      });
    } catch {
      // Some integrations may not emit this reliably; continue.
    }

    if (Array.isArray(interactionSteps) && interactionSteps.length > 0) {
      await runInteractionSteps(page, interactionSteps);
    } else {
      await sleep(profileDurationMs);
    }

    profilingActive = false;
    bridge.send('stopProfiling', undefined);

    try {
      await bridge.waitForEvent('profilingStatus', {
        timeoutMs: 5000,
        predicate: (payload) => payload === false,
      });
    } catch {
      // Some integrations may not emit this reliably; continue.
    }

    if (rendererIDs.size === 0) {
      throw new Error('No renderer IDs detected from DevTools operations; cannot request profiling data');
    }

    const profilingPayloads = [];
    for (const rendererID of [...rendererIDs].sort((a, b) => a - b)) {
      bridge.send('getProfilingData', {rendererID});
      const payload = await bridge.waitForEvent('profilingData', {
        timeoutMs: 15000,
        predicate: (value) => Number(value?.rendererID) === rendererID,
      });
      profilingPayloads.push(payload);
    }

    const dataForRoots = [];
    const timelineData = [];

    for (const profilingPayload of profilingPayloads) {
      if (profilingPayload?.timelineData != null) {
        timelineData.push(profilingPayload.timelineData);
      }

      const roots = Array.isArray(profilingPayload?.dataForRoots)
        ? profilingPayload.dataForRoots
        : [];

      for (const root of roots) {
        const rootID = Number(root?.rootID);
        if (Number.isFinite(rootID) && Number.isFinite(profilingPayload?.rendererID)) {
          rootToRenderer.set(rootID, Number(profilingPayload.rendererID));
        }
        const snapshots = snapshotsByRoot.get(rootID) ?? serializeSnapshotTree(liveTreesByRoot.get(rootID));
        const operations = operationsDuringProfilingByRoot.get(rootID) ?? [];

        dataForRoots.push({
          ...root,
          operations,
          snapshots,
        });
      }
    }

    const inspectedElements = await captureInspectedElementsEnrichment({
      bridge,
      dataForRoots,
      rootToRenderer,
      enabled: inspectElements === true,
      maxFibersPerRoot: inspectElementsMaxPerRoot,
      timeoutMs: inspectElementsTimeoutMs,
      inspectConcurrency: inspectElementsConcurrency,
      parseHookNamesEnabled: parseHookNamesEnabled === true,
      parseHookNamesTimeoutMs,
      hookSourceFetcher,
    });

    const exportWarnings = [];
    const commitCountForWarning = dataForRoots.reduce(
      (sum, root) => sum + (Array.isArray(root?.commitData) ? root.commitData.length : 0),
      0,
    );
    if (commitCountForWarning === 0) {
      exportWarnings.push(
        'No commits were captured. Ensure React DevTools profiling is supported for this build and that interaction steps trigger React updates.',
      );
    }

    const exportPayload = {
      version: 5,
      dataForRoots,
      ...(timelineData.length > 0 ? {timelineData} : {}),
      automationMeta: {
        recorder: {
          name: 'react-profiler-mcp',
          version: '0.4.0',
          generatedAt: new Date().toISOString(),
          inspectElementsEnabled: inspectElements === true,
          inspectElementsMaxPerRoot: inspectElementsMaxPerRoot,
          inspectElementsTimeoutMs: inspectElementsTimeoutMs,
          inspectElementsConcurrency: inspectElementsConcurrency,
          parseHookNamesEnabled: parseHookNamesEnabled === true,
          parseHookNamesTimeoutMs,
          parseHookNamesSourceRoots: hookSourceFetcher.getSourceRoots(),
          parseHookNamesAliasSummary: hookSourceFetcher.getAliasSummary(),
          warnings: exportWarnings,
        },
        inspectedElements,
      },
    };

    const resolvedOutputPath = resolvePath(cwd, outputPath);
    await mkdir(path.dirname(resolvedOutputPath), {recursive: true});
    await writeFile(resolvedOutputPath, `${JSON.stringify(exportPayload, null, 2)}\n`, 'utf8');

    const commitCount = commitCountForWarning;
    const warnings = [];
    if (commitCount === 0) {
      warnings.push(
        'No commits were captured. Ensure React DevTools profiling is supported for this build and that interaction steps trigger React updates.',
      );
    }

    return {
      outputPath: resolvedOutputPath,
      rootCount: dataForRoots.length,
      commitCount,
      rendererIDs: [...rendererIDs].sort((a, b) => a - b),
      roots: dataForRoots.map((root) => ({
        rootID: root.rootID,
        displayName: root.displayName,
        commitCount: Array.isArray(root.commitData) ? root.commitData.length : 0,
        operationsCount: Array.isArray(root.operations) ? root.operations.length : 0,
        snapshotSize: Array.isArray(root.snapshots) ? root.snapshots.length : 0,
        rendererID: rootToRenderer.get(root.rootID) ?? null,
      })),
      recordChangeDescriptions: recordChangeDescriptions === true,
      recordTimeline: recordTimeline === true,
      inspectElementsConcurrency,
      parseHookNamesEnabled: parseHookNamesEnabled === true,
      parseHookNamesTimeoutMs,
      parseHookNamesSourceRoots: hookSourceFetcher.getSourceRoots(),
      inspectedElements,
      warnings,
    };
  } finally {
    await Promise.allSettled([browser.close(), bridge.close()]);
  }
}
