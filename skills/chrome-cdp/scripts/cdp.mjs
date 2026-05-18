#!/usr/bin/env node
// cdp - lightweight Chrome DevTools Protocol CLI
// Uses raw CDP over WebSocket, no Puppeteer dependency.
// Requires Node 22+ (built-in WebSocket).
//
// Per-tab persistent daemon: page commands go through a daemon that holds
// the CDP session open. Chrome's "Allow debugging" modal fires once per
// daemon (= once per tab). Daemons auto-exit after 20min idle.

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';
import { pathToFileURL } from 'url';
import { spawn } from 'child_process';
import net from 'net';

const TIMEOUT = 15000;
const NAVIGATION_TIMEOUT = 30000;
const IDLE_TIMEOUT = 20 * 60 * 1000;
const DAEMON_CONNECT_RETRIES = 20;
const DAEMON_CONNECT_DELAY = 300;
const MIN_TARGET_PREFIX_LEN = 8;
const IS_WINDOWS = process.platform === 'win32';
if (!IS_WINDOWS) process.umask(0o077);
const RUNTIME_DIR = IS_WINDOWS
  ? resolve(process.env.LOCALAPPDATA || resolve(homedir(), 'AppData', 'Local'), 'cdp')
  : process.env.XDG_RUNTIME_DIR
    ? resolve(process.env.XDG_RUNTIME_DIR, 'cdp')
    : resolve(homedir(), '.cache', 'cdp');
try { mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 }); } catch {}
const PAGES_CACHE = resolve(RUNTIME_DIR, 'pages.json');

// console / netcapture ring buffer caps and limits
const CONSOLE_BUFFER_CAP = 1000;
const NETCAPTURE_BUFFER_CAP = 500;
const CONSOLE_RECORD_MAX_BYTES = 8 * 1024;
const NETCAPTURE_RECORD_MAX_BYTES = 4 * 1024;
const DEFAULT_LAST_N = 50;
const BODY_FETCH_MAX_BYTES = 5 * 1024 * 1024;

// MIME types where the body is safe to print inline. Everything else
// requires --head <bytes> or --save <path> from the caller.
const TEXT_MIME_PATTERNS = [
  /^text\//i,
  /^application\/json\b/i,
  /^application\/xml\b/i,
  /^application\/javascript\b/i,
  /^application\/x-www-form-urlencoded\b/i,
  /^application\/.*\+json\b/i,
  /^application\/.*\+xml\b/i,
];

const WAITFOR_DEFAULT_TIMEOUT = 10000;
const WAITFOR_POLL_INTERVAL = 100;

function sockPath(targetId) {
  return IS_WINDOWS
    ? `\\\\.\\pipe\\cdp-${targetId}`
    : resolve(RUNTIME_DIR, `cdp-${targetId}.sock`);
}

/**
 * Probe the TCP port from the DevToolsActivePort file to confirm Chrome is
 * actually running and accepting connections on that port.
 *
 * Why TCP, not HTTP /json/version: Chrome's HTTP discovery endpoints are
 * only enabled when Chrome is launched with `--remote-debugging-port` on the
 * command line; toggling remote debugging via chrome://inspect#remote-
 * debugging brings up the WebSocket browser target but leaves /json/version
 * (and friends) returning 404. The WebSocket endpoint we actually use works
 * regardless of HTTP discovery state. A TCP-level connect tells us whether
 * the port is listening, which is exactly what the WebSocket upgrade needs.
 *
 * Resolves silently on TCP connect success. Throws an actionable Error on
 * ECONNREFUSED (Chrome closed / debugging off) or timeout (something hung
 * on the port).
 */
async function probeCdpEndpoint(host, port, portFile) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port: parseInt(port, 10) });
    let settled = false;

    const done = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch {}
      if (err) reject(err);
      else resolve();
    };

    const timer = setTimeout(() => {
      done(new Error(
        `Chrome's remote-debug port at ${host}:${port} did not respond within 2s.\n` +
        `Port file may be stale: ${portFile}\n` +
        `Toggle remote debugging at chrome://inspect/#remote-debugging.`
      ));
    }, 2000);

    sock.once('connect', () => done());
    sock.once('error', (err) => {
      if (err.code === 'ECONNREFUSED') {
        done(new Error(
          `Chrome's remote-debug port at ${host}:${port} is not listening.\n` +
          `  This usually means:\n` +
          `    • Chrome is closed, or\n` +
          `    • Chrome was started without remote debugging, or\n` +
          `    • Remote debugging was toggled off in chrome://inspect/#remote-debugging.\n` +
          `  Stale port file: ${portFile}\n` +
          `  Open Chrome and toggle remote debugging on, then retry.`
        ));
        return;
      }
      done(new Error(
        `Could not reach Chrome's remote-debug port at ${host}:${port}: ${err.message}\n` +
        `Port file: ${portFile}`
      ));
    });
  });
}

async function getWsUrl() {
  const home = homedir();
  // macOS: ~/Library/Application Support/<name>/DevToolsActivePort
  const macBrowsers = [
    'Google/Chrome', 'Google/Chrome Beta', 'Google/Chrome for Testing',
    'Chromium', 'BraveSoftware/Brave-Browser', 'Microsoft Edge',
  ];
  // Linux: ~/.config/<name>/DevToolsActivePort
  const linuxBrowsers = [
    'google-chrome', 'google-chrome-beta', 'chromium',
    'vivaldi', 'vivaldi-snapshot',
    'BraveSoftware/Brave-Browser', 'microsoft-edge',
  ];
  // Linux Flatpak: ~/.var/app/<app-id>/config/<name>/DevToolsActivePort
  const flatpakBrowsers = [
    ['org.chromium.Chromium', 'chromium'],
    ['com.google.Chrome', 'google-chrome'],
    ['com.brave.Browser', 'BraveSoftware/Brave-Browser'],
    ['com.microsoft.Edge', 'microsoft-edge'],
    ['com.vivaldi.Vivaldi', 'vivaldi'],
  ];
  const candidates = [
    process.env.CDP_PORT_FILE,
    ...macBrowsers.flatMap(b => [
      resolve(home, 'Library/Application Support', b, 'DevToolsActivePort'),
      resolve(home, 'Library/Application Support', b, 'Default/DevToolsActivePort'),
    ]),
    ...linuxBrowsers.flatMap(b => [
      resolve(home, '.config', b, 'DevToolsActivePort'),
      resolve(home, '.config', b, 'Default/DevToolsActivePort'),
    ]),
    ...flatpakBrowsers.flatMap(([appId, name]) => [
      resolve(home, '.var/app', appId, 'config', name, 'DevToolsActivePort'),
      resolve(home, '.var/app', appId, 'config', name, 'Default/DevToolsActivePort'),
    ]),
    // Windows: %LOCALAPPDATA%/<name>/User Data/DevToolsActivePort
    ...(IS_WINDOWS ? ['Google/Chrome', 'BraveSoftware/Brave-Browser', 'Microsoft/Edge'].flatMap(b => {
      const base = process.env.LOCALAPPDATA || resolve(home, 'AppData/Local');
      return [
        resolve(base, b, 'User Data/DevToolsActivePort'),
        resolve(base, b, 'User Data/Default/DevToolsActivePort'),
      ];
    }) : []),
  ].filter(Boolean);
  const portFile = candidates.find(p => existsSync(p));
  if (!portFile) {
    throw new Error(
      `No DevToolsActivePort found in any known Chrome profile location.\n` +
      `  Enable remote debugging at chrome://inspect/#remote-debugging,\n` +
      `  or set CDP_PORT_FILE to the path of your browser's DevToolsActivePort file.`
    );
  }
  const lines = readFileSync(portFile, 'utf8').trim().split('\n');
  if (lines.length < 2 || !lines[0] || !lines[1]) throw new Error(`Invalid DevToolsActivePort file: ${portFile}`);
  const host = process.env.CDP_HOST || '127.0.0.1';
  await probeCdpEndpoint(host, lines[0], portFile);
  return `ws://${host}:${lines[0]}${lines[1]}`;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));


function resolvePrefix(prefix, candidates, noun = 'target', missingHint = '') {
  const upper = prefix.toUpperCase();
  const matches = candidates.filter(candidate => candidate.toUpperCase().startsWith(upper));
  if (matches.length === 0) {
    const hint = missingHint ? ` ${missingHint}` : '';
    throw new Error(`No ${noun} matching prefix "${prefix}".${hint}`);
  }
  if (matches.length > 1) {
    throw new Error(`Ambiguous prefix "${prefix}" — matches ${matches.length} ${noun}s. Use more characters.`);
  }
  return matches[0];
}

function getDisplayPrefixLength(targetIds) {
  if (targetIds.length === 0) return MIN_TARGET_PREFIX_LEN;
  const maxLen = Math.max(...targetIds.map(id => id.length));
  for (let len = MIN_TARGET_PREFIX_LEN; len <= maxLen; len++) {
    const prefixes = new Set(targetIds.map(id => id.slice(0, len).toUpperCase()));
    if (prefixes.size === targetIds.length) return len;
  }
  return maxLen;
}

// ---------------------------------------------------------------------------
// Generic helpers used by console / netcapture / storage / waitfor commands
// ---------------------------------------------------------------------------

/**
 * Parse a flag stream like ['--last', '200', '--json', '--level', 'error,warn']
 * into { flags: { last: '200', json: true, level: 'error,warn' }, positional: [...] }.
 * Bare `--key` flags become `true`. `--key value` becomes the string value.
 * Anything not starting with `--` is positional.
 */
function parseFlags(tokens) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (typeof t !== 'string' || !t.startsWith('--')) {
      positional.push(t);
      continue;
    }
    const key = t.slice(2);
    const next = tokens[i + 1];
    if (next === undefined || (typeof next === 'string' && next.startsWith('--'))) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i++;
    }
  }
  return { flags, positional };
}

/**
 * Parse a `--since` value (ISO 8601 timestamp or relative duration like "5m",
 * "1h", "30s", "200ms") into a millisecond epoch threshold. Returns null on
 * invalid input so the caller can fall back to "no filter".
 */
function parseSince(input) {
  if (!input) return null;
  if (typeof input !== 'string') return null;
  const relMatch = input.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/i);
  if (relMatch) {
    const n = parseFloat(relMatch[1]);
    const unit = relMatch[2].toLowerCase();
    const mult = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60000 : 3600000;
    return Date.now() - Math.round(n * mult);
  }
  const t = Date.parse(input);
  return Number.isFinite(t) ? t : null;
}

/**
 * Parse a `--timeout` value (relative duration only, e.g. "10s", "500ms") to
 * milliseconds. Bare numbers are treated as milliseconds. Returns the default
 * on invalid input.
 */
function parseDurationToMs(input, fallback) {
  if (input === undefined || input === null || input === true) return fallback;
  if (typeof input === 'number') return input;
  const s = String(input);
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const match = s.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/i);
  if (!match) return fallback;
  const n = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  const mult = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60000 : 3600000;
  return Math.round(n * mult);
}

/**
 * Build a status-filter predicate from a comma-separated input like "4xx,5xx,404".
 * Returns null when the input is missing — caller treats as no filter.
 */
function parseStatusFilter(input) {
  if (!input || input === true) return null;
  const tokens = String(input).split(',').map(s => s.trim()).filter(Boolean);
  if (tokens.length === 0) return null;
  const checks = tokens.map(tok => {
    const fam = tok.match(/^([1-5])xx$/i);
    if (fam) {
      const lo = parseInt(fam[1], 10) * 100;
      const hi = lo + 99;
      return (status) => status != null && status >= lo && status <= hi;
    }
    if (/^\d{3}$/.test(tok)) {
      const exact = parseInt(tok, 10);
      return (status) => status === exact;
    }
    return () => false;
  });
  return (status) => checks.some(c => c(status));
}

function parseCsvFilter(input) {
  if (!input || input === true) return null;
  const tokens = String(input).split(',').map(s => s.trim()).filter(Boolean);
  if (tokens.length === 0) return null;
  return tokens;
}

function parseRegexFilter(input) {
  if (!input || input === true) return null;
  try { return new RegExp(input); } catch { return null; }
}

function isTextMime(mime) {
  if (!mime) return false;
  return TEXT_MIME_PATTERNS.some(re => re.test(mime));
}

/**
 * Truncate a string at maxBytes (UTF-8 conservative — counts code units). Returns
 * { value, truncated, originalLength }. The trailing marker "…(truncated, +N bytes elided)"
 * is appended when truncation occurred.
 */
function truncateString(s, maxBytes) {
  if (typeof s !== 'string') s = String(s ?? '');
  if (s.length <= maxBytes) return { value: s, truncated: false, originalLength: s.length };
  const elided = s.length - maxBytes;
  return {
    value: s.slice(0, maxBytes) + `…(truncated, +${elided} bytes elided)`,
    truncated: true,
    originalLength: s.length,
  };
}

/**
 * Compact a CDP requestId (like "F2A3B7C9.42") to a short, agent-friendly prefix
 * that is still unique within a tab's lifetime. CDP requestIds embed a session
 * prefix + a per-session counter; stripping the prefix and taking the first 8
 * chars of the remainder gives a stable handle.
 */
function compactRequestId(fullId) {
  if (!fullId) return '';
  const tail = fullId.includes('.') ? fullId.split('.').pop() : fullId;
  return (tail.length <= 8 ? tail : tail.slice(0, 8)).padEnd(8);
}

/**
 * Human-readable byte size. 0..1023 -> "Nb", 1024..1MB -> "N.NKB", etc.
 */
function formatSize(bytes) {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function formatDurationMs(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

function formatTimestampMs(ms) {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const fff = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${fff}`;
}

/**
 * Render a CDP RemoteObject (returned by Runtime.consoleAPICalled args, etc.)
 * to a short human-readable string. Not aiming for DevTools fidelity — readability
 * over perfection.
 */
function formatRemoteObject(obj) {
  if (obj == null) return 'undefined';
  if (obj.type === 'undefined') return 'undefined';
  if (obj.type === 'string') return obj.value;
  if (obj.type === 'number' || obj.type === 'boolean') return String(obj.value);
  if (obj.type === 'symbol') return obj.description || 'Symbol()';
  if (obj.type === 'bigint') return (obj.unserializableValue || obj.description || '0') + 'n';
  if (obj.subtype === 'null') return 'null';
  if (obj.subtype === 'error') return obj.description || 'Error';
  if (obj.subtype === 'regexp') return obj.description || '/regex/';
  if (obj.subtype === 'date') return obj.description || 'Date';
  if (obj.description) return obj.description;
  return `[object ${obj.className || 'Object'}]`;
}

/**
 * Render a CDP exceptionDetails payload (from Runtime.exceptionThrown) into
 * a single string capturing both the message and the stack.
 */
function formatExceptionDetails(d) {
  if (!d) return 'unknown exception';
  if (d.exception) {
    const obj = formatRemoteObject(d.exception);
    if (d.exception.description) return d.exception.description;
    return obj;
  }
  return d.text || 'exception';
}

/**
 * Render a CDP StackTrace into a multi-line "  at fn (url:line:col)" string.
 */
function formatStackTrace(stack) {
  if (!stack || !stack.callFrames) return null;
  return stack.callFrames.map(f => {
    const fn = f.functionName || '<anonymous>';
    const url = f.url || '<inline>';
    return `  at ${fn} (${url}:${f.lineNumber + 1}:${f.columnNumber + 1})`;
  }).join('\n');
}

function pluralize(n, singular, plural) {
  return `${n.toLocaleString()} ${n === 1 ? singular : (plural || `${singular}s`)}`;
}

function safeJsonParse(s) {
  if (!s) return {};
  try { return JSON.parse(s); } catch { return {}; }
}

// ---------------------------------------------------------------------------
// CDP WebSocket client
// ---------------------------------------------------------------------------

class CDP {
  #ws; #id = 0; #pending = new Map(); #eventHandlers = new Map(); #closeHandlers = [];

  async connect(wsUrl) {
    return new Promise((res, rej) => {
      this.#ws = new WebSocket(wsUrl);
      this.#ws.onopen = () => res();
      this.#ws.onerror = (e) => rej(new Error('WebSocket error: ' + (e.message || e.type)));
      this.#ws.onclose = () => this.#closeHandlers.forEach(h => h());
      this.#ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && this.#pending.has(msg.id)) {
          const { resolve, reject } = this.#pending.get(msg.id);
          this.#pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        } else if (msg.method && this.#eventHandlers.has(msg.method)) {
          for (const handler of [...this.#eventHandlers.get(msg.method)]) {
            handler(msg.params || {}, msg);
          }
        }
      };
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      this.#ws.send(JSON.stringify(msg));
      setTimeout(() => {
        if (this.#pending.has(id)) {
          this.#pending.delete(id);
          reject(new Error(`Timeout: ${method}`));
        }
      }, TIMEOUT);
    });
  }

  onEvent(method, handler) {
    if (!this.#eventHandlers.has(method)) this.#eventHandlers.set(method, new Set());
    const handlers = this.#eventHandlers.get(method);
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.#eventHandlers.delete(method);
    };
  }

  waitForEvent(method, timeout = TIMEOUT) {
    let settled = false;
    let off;
    let timer;
    const promise = new Promise((resolve, reject) => {
      off = this.onEvent(method, (params) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        resolve(params);
      });
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        off();
        reject(new Error(`Timeout waiting for event: ${method}`));
      }, timeout);
    });
    return {
      promise,
      cancel() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off?.();
      },
    };
  }

  onClose(handler) { this.#closeHandlers.push(handler); }
  close() { this.#ws.close(); }
}

// ---------------------------------------------------------------------------
// Ring buffers — console messages + network requests
// ---------------------------------------------------------------------------

/**
 * Capped, drop-oldest ring buffer with a navigation-reset hook.
 *
 * - push(rec): append; if at cap, drop oldest and increment droppedCount.
 * - snapshot(): return a fresh array copy in chronological order.
 * - clear(): drop all records and reset droppedCount.
 * - markNavigation(url): insert a synthetic boundary record so a snapshot reads
 *   as page-scoped. Resets droppedCount to 0 because the floor effectively moved.
 *
 * `NetcaptureBuffer` adds an index keyed by requestId so the network event
 * handlers can update an existing record in O(1).
 */
class RingBuffer {
  constructor(cap) {
    this.cap = cap;
    this.records = [];
    this.droppedCount = 0;
    this.lastResetTs = Date.now();
  }

  push(rec) {
    if (this.records.length >= this.cap) {
      this.records.shift();
      this.droppedCount++;
    }
    this.records.push(rec);
  }

  snapshot() {
    return this.records.slice();
  }

  clear() {
    this.records = [];
    this.droppedCount = 0;
    this.lastResetTs = Date.now();
  }

  markNavigation(url) {
    this.records = [];
    this.droppedCount = 0;
    this.lastResetTs = Date.now();
    this.records.push({ kind: 'boundary', ts: Date.now(), url });
  }
}

/**
 * Specialised ring buffer for netcapture. Adds requestId → record-index lookup
 * so responseReceived / loadingFinished / loadingFailed can patch an existing
 * record without an O(n) scan.
 */
class NetcaptureBuffer extends RingBuffer {
  constructor(cap) {
    super(cap);
    this.indexById = new Map();
  }

  push(rec) {
    if (this.records.length >= this.cap) {
      const dropped = this.records.shift();
      this.droppedCount++;
      if (dropped && dropped.requestId) this.indexById.delete(dropped.requestId);
      // shift invalidates the indices stored in the map; rebuild lazily below
      this.indexById.clear();
      for (let i = 0; i < this.records.length; i++) {
        const r = this.records[i];
        if (r.requestId) this.indexById.set(r.requestId, i);
      }
    }
    if (rec.requestId) this.indexById.set(rec.requestId, this.records.length);
    this.records.push(rec);
  }

  findByRequestId(requestId) {
    const idx = this.indexById.get(requestId);
    return idx === undefined ? null : this.records[idx];
  }

  clear() {
    super.clear();
    this.indexById = new Map();
  }

  markNavigation(url) {
    super.markNavigation(url);
    this.indexById = new Map();
  }
}

// ---------------------------------------------------------------------------
// Command implementations — return strings, take (cdp, sessionId)
// ---------------------------------------------------------------------------

async function getPages(cdp) {
  const { targetInfos } = await cdp.send('Target.getTargets');
  return targetInfos.filter(t => t.type === 'page' && !t.url.startsWith('chrome://'));
}

function formatPageList(pages) {
  const prefixLen = getDisplayPrefixLength(pages.map(p => p.targetId));
  return pages.map(p => {
    const id = p.targetId.slice(0, prefixLen).padEnd(prefixLen);
    const title = p.title.substring(0, 54).padEnd(54);
    return `${id}  ${title}  ${p.url}`;
  }).join('\n');
}

function shouldShowAxNode(node, compact = false) {
  const role = node.role?.value || '';
  const name = node.name?.value ?? '';
  const value = node.value?.value;
  if (compact && role === 'InlineTextBox') return false;
  return role !== 'none' && role !== 'generic' && !(name === '' && (value === '' || value == null));
}

function formatAxNode(node, depth) {
  const role = node.role?.value || '';
  const name = node.name?.value ?? '';
  const value = node.value?.value;
  const indent = '  '.repeat(Math.min(depth, 10));
  let line = `${indent}[${role}]`;
  if (name !== '') line += ` ${name}`;
  if (!(value === '' || value == null)) line += ` = ${JSON.stringify(value)}`;
  return line;
}

function orderedAxChildren(node, nodesById, childrenByParent) {
  const children = [];
  const seen = new Set();
  for (const childId of node.childIds || []) {
    const child = nodesById.get(childId);
    if (child && !seen.has(child.nodeId)) {
      seen.add(child.nodeId);
      children.push(child);
    }
  }
  for (const child of childrenByParent.get(node.nodeId) || []) {
    if (!seen.has(child.nodeId)) {
      seen.add(child.nodeId);
      children.push(child);
    }
  }
  return children;
}

async function snapshotStr(cdp, sid, compact = false) {
  const { nodes } = await cdp.send('Accessibility.getFullAXTree', {}, sid);
  const nodesById = new Map(nodes.map(node => [node.nodeId, node]));
  const childrenByParent = new Map();
  for (const node of nodes) {
    if (!node.parentId) continue;
    if (!childrenByParent.has(node.parentId)) childrenByParent.set(node.parentId, []);
    childrenByParent.get(node.parentId).push(node);
  }

  const lines = [];
  const visited = new Set();
  function visit(node, depth) {
    if (!node || visited.has(node.nodeId)) return;
    visited.add(node.nodeId);
    if (shouldShowAxNode(node, compact)) lines.push(formatAxNode(node, depth));
    for (const child of orderedAxChildren(node, nodesById, childrenByParent)) {
      visit(child, depth + 1);
    }
  }

  const roots = nodes.filter(node => !node.parentId || !nodesById.has(node.parentId));
  for (const root of roots) visit(root, 0);
  for (const node of nodes) visit(node, 0);

  return lines.join('\n');
}

async function evalStr(cdp, sid, expression) {
  await cdp.send('Runtime.enable', {}, sid);
  const result = await cdp.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  }, sid);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || result.exceptionDetails.exception?.description);
  }
  const val = result.result.value;
  return typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val ?? '');
}

async function shotStr(cdp, sid, filePath, targetId, opts = {}) {
  // Get device scale factor so we can report coordinate mapping
  let dpr = 1;
  try {
    const metrics = await cdp.send('Page.getLayoutMetrics', {}, sid);
    dpr = metrics.visualViewport?.clientWidth
      ? metrics.cssVisualViewport?.clientWidth
        ? Math.round((metrics.visualViewport.clientWidth / metrics.cssVisualViewport.clientWidth) * 100) / 100
        : 1
      : 1;
    // Simpler: deviceScaleFactor is on the root Page metrics
    const { deviceScaleFactor } = await cdp.send('Emulation.getDeviceMetricsOverride', {}, sid).catch(() => ({}));
    if (deviceScaleFactor) dpr = deviceScaleFactor;
  } catch {}
  // Fallback: try to get DPR from JS
  if (dpr === 1) {
    try {
      const raw = await evalStr(cdp, sid, 'window.devicePixelRatio');
      const parsed = parseFloat(raw);
      if (parsed > 0) dpr = parsed;
    } catch {}
  }

  const full = !!opts.full;
  const shotParams = { format: 'png' };
  if (full) shotParams.captureBeyondViewport = true;
  const { data } = await cdp.send('Page.captureScreenshot', shotParams, sid);
  const defaultName = `screenshot-${(targetId || 'unknown').slice(0, 8)}${full ? '-full' : ''}.png`;
  const out = filePath || resolve(RUNTIME_DIR, defaultName);
  writeFileSync(out, Buffer.from(data, 'base64'));

  const lines = [out];
  lines.push(`Screenshot saved${full ? ' (full page)' : ' (viewport)'}. Device pixel ratio (DPR): ${dpr}`);
  lines.push(`Coordinate mapping:`);
  lines.push(`  Screenshot pixels → CSS pixels (for CDP Input events): divide by ${dpr}`);
  lines.push(`  e.g. screenshot point (${Math.round(100 * dpr)}, ${Math.round(200 * dpr)}) → CSS (100, 200) → use clickxy <target> 100 200`);
  if (dpr !== 1) {
    lines.push(`  On this ${dpr}x display: CSS px = screenshot px / ${dpr} ≈ screenshot px × ${Math.round(100/dpr)/100}`);
  }
  return lines.join('\n');
}

async function htmlStr(cdp, sid, selector) {
  const expr = selector
    ? `document.querySelector(${JSON.stringify(selector)})?.outerHTML || 'Element not found'`
    : `document.documentElement.outerHTML`;
  return evalStr(cdp, sid, expr);
}

async function waitForDocumentReady(cdp, sid, timeoutMs = NAVIGATION_TIMEOUT) {
  const deadline = Date.now() + timeoutMs;
  let lastState = '';
  let lastError;
  while (Date.now() < deadline) {
    try {
      const state = await evalStr(cdp, sid, 'document.readyState');
      lastState = state;
      if (state === 'complete') return;
    } catch (e) {
      lastError = e;
    }
    await sleep(200);
  }

  if (lastState) {
    throw new Error(`Timed out waiting for navigation to finish (last readyState: ${lastState})`);
  }
  if (lastError) {
    throw new Error(`Timed out waiting for navigation to finish (${lastError.message})`);
  }
  throw new Error('Timed out waiting for navigation to finish');
}

async function navStr(cdp, sid, url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      throw new Error(`Only http/https URLs allowed, got: ${url}`);
  } catch (e) {
    if (e.message.startsWith('Only')) throw e;
    throw new Error(`Invalid URL: ${url}`);
  }
  await cdp.send('Page.enable', {}, sid);
  const loadEvent = cdp.waitForEvent('Page.loadEventFired', NAVIGATION_TIMEOUT);
  const result = await cdp.send('Page.navigate', { url }, sid);
  if (result.errorText) {
    loadEvent.cancel();
    throw new Error(result.errorText);
  }
  if (result.loaderId) {
    await loadEvent.promise;
  } else {
    loadEvent.cancel();
  }
  await waitForDocumentReady(cdp, sid, 5000);
  return `Navigated to ${url}`;
}

async function netStr(cdp, sid) {
  const raw = await evalStr(cdp, sid, `JSON.stringify(performance.getEntriesByType('resource').map(e => ({
    name: e.name.substring(0, 120), type: e.initiatorType,
    duration: Math.round(e.duration), size: e.transferSize
  })))`);
  return JSON.parse(raw).map(e =>
    `${String(e.duration).padStart(5)}ms  ${String(e.size || '?').padStart(8)}B  ${e.type.padEnd(8)}  ${e.name}`
  ).join('\n');
}

// Click element by CSS selector
async function clickStr(cdp, sid, selector) {
  if (!selector) throw new Error('CSS selector required');
  const expr = `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, error: 'Element not found: ' + ${JSON.stringify(selector)} };
      el.scrollIntoView({ block: 'center' });
      el.click();
      return { ok: true, tag: el.tagName, text: el.textContent.trim().substring(0, 80) };
    })()
  `;
  const result = await evalStr(cdp, sid, expr);
  const r = JSON.parse(result);
  if (!r.ok) throw new Error(r.error);
  return `Clicked <${r.tag}> "${r.text}"`;
}

// Click at CSS pixel coordinates using Input.dispatchMouseEvent
async function clickXyStr(cdp, sid, x, y) {
  const cx = parseFloat(x);
  const cy = parseFloat(y);
  if (isNaN(cx) || isNaN(cy)) throw new Error('x and y must be numbers (CSS pixels)');
  const base = { x: cx, y: cy, button: 'left', clickCount: 1, modifiers: 0 };
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved' }, sid);
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' }, sid);
  await sleep(50);
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' }, sid);
  return `Clicked at CSS (${cx}, ${cy})`;
}

// Type text using Input.insertText (works in cross-origin iframes, unlike eval)
async function typeStr(cdp, sid, text) {
  if (text == null || text === '') throw new Error('text required');
  await cdp.send('Input.insertText', { text }, sid);
  return `Typed ${text.length} characters`;
}

// Load-more: repeatedly click a button/selector until it disappears
async function loadAllStr(cdp, sid, selector, intervalMs = 1500) {
  if (!selector) throw new Error('CSS selector required');
  let clicks = 0;
  const deadline = Date.now() + 5 * 60 * 1000; // 5-minute hard cap
  while (Date.now() < deadline) {
    const exists = await evalStr(cdp, sid,
      `!!document.querySelector(${JSON.stringify(selector)})`
    );
    if (exists !== 'true') break;
    const clickExpr = `
      (function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.scrollIntoView({ block: 'center' });
        el.click();
        return true;
      })()
    `;
    const clicked = await evalStr(cdp, sid, clickExpr);
    if (clicked !== 'true') break;
    clicks++;
    await sleep(intervalMs);
  }
  return `Clicked "${selector}" ${clicks} time(s) until it disappeared`;
}

// Send a raw CDP command and return the result as JSON
async function evalRawStr(cdp, sid, method, paramsJson) {
  if (!method) throw new Error('CDP method required (e.g. "DOM.getDocument")');
  let params = {};
  if (paramsJson) {
    try { params = JSON.parse(paramsJson); }
    catch { throw new Error(`Invalid JSON params: ${paramsJson}`); }
  }
  const result = await cdp.send(method, params, sid);
  return JSON.stringify(result, null, 2);
}

// ---------------------------------------------------------------------------
// console — formatter functions
// ---------------------------------------------------------------------------

/**
 * Build a filtered slice of the console buffer per opts, render to text or JSON.
 * Never drains. `console clear` is the only path that mutates state.
 */
function consoleStr(buf, opts = {}) {
  const all = buf.snapshot();
  const sinceTs = opts.since ? parseSince(opts.since) : null;
  const levelFilter = parseCsvFilter(opts.level);
  const frameFilter = parseCsvFilter(opts.frame);

  const filtered = all.filter(rec => {
    if (rec.kind === 'boundary') return true;
    if (sinceTs !== null && rec.ts < sinceTs) return false;
    if (levelFilter && !levelFilter.includes(rec.level)) return false;
    if (frameFilter) {
      const matchTop = frameFilter.includes('top') && rec.frame === 'top';
      const matchOop = frameFilter.includes('oopif') && rec.frame !== 'top';
      const matchExact = frameFilter.some(f => f !== 'top' && f !== 'oopif' && rec.frame === f);
      if (!matchTop && !matchOop && !matchExact) return false;
    }
    return true;
  });

  const lastN = opts.all ? filtered.length
    : opts.last ? Math.max(1, parseInt(opts.last, 10) || DEFAULT_LAST_N)
    : DEFAULT_LAST_N;
  const shown = filtered.slice(-lastN);

  if (opts.json) {
    return JSON.stringify({
      total: all.length,
      filtered: filtered.length,
      dropped: buf.droppedCount,
      cap: buf.cap,
      shown: shown.length,
      records: shown,
    }, null, 2);
  }

  const counts = { log: 0, info: 0, warn: 0, error: 0, debug: 0 };
  for (const r of all) {
    if (r.kind === 'boundary') continue;
    counts[r.level] = (counts[r.level] ?? 0) + 1;
  }

  const headerParts = [
    `${pluralize(all.length, 'message')} buffered (cap ${buf.cap})`,
    `${counts.log} log · ${counts.info} info · ${counts.warn} warn · ${counts.error} error · ${counts.debug} debug`,
  ];
  if (buf.droppedCount > 0) headerParts.push(`${buf.droppedCount} earlier dropped`);
  if (filtered.length !== all.length) headerParts.push(`${filtered.length} match filter`);
  headerParts.push(`showing last ${shown.length}`);
  const header = headerParts.join(' · ') + '.';

  if (shown.length === 0) {
    return header + '\n(no messages)';
  }

  const lines = shown.map(rec => {
    if (rec.kind === 'boundary') {
      return `--- navigation to ${rec.url || '<unknown>'} (buffer reset) ---`;
    }
    const t = formatTimestampMs(rec.ts);
    const lvl = (rec.level || 'log').padEnd(5);
    const frame = rec.frame && rec.frame !== 'top' ? ` [iframe: ${rec.frame}]` : '';
    const main = `[${t}] ${lvl} ${rec.text}${frame}`;
    if (rec.stack) {
      return `${main}\n${rec.stack.split('\n').map(l => '  ' + l).join('\n')}`;
    }
    return main;
  });

  return [header, '', ...lines].join('\n');
}

// ---------------------------------------------------------------------------
// netcapture — formatter functions
// ---------------------------------------------------------------------------

function netcaptureListStr(buf, opts = {}) {
  const all = buf.snapshot();
  const sinceTs = opts.since ? parseSince(opts.since) : null;
  const statusFilter = parseStatusFilter(opts.status);
  const methodFilter = parseCsvFilter(opts.method);
  const mimeFilter = opts.mime && opts.mime !== true ? String(opts.mime).toLowerCase() : null;
  const urlContains = opts['url-contains'] && opts['url-contains'] !== true ? String(opts['url-contains']) : null;
  const urlRegex = parseRegexFilter(opts['url-regex']);
  const frameFilter = parseCsvFilter(opts.frame);

  const filtered = all.filter(rec => {
    if (rec.kind === 'boundary') return true;
    if (sinceTs !== null && rec.startTime < sinceTs) return false;
    if (statusFilter && !statusFilter(rec.status)) return false;
    if (methodFilter && !methodFilter.includes(rec.method)) return false;
    if (mimeFilter && !(rec.resMime || '').toLowerCase().includes(mimeFilter)) return false;
    if (urlContains && !rec.url.includes(urlContains)) return false;
    if (urlRegex && !urlRegex.test(rec.url)) return false;
    if (frameFilter) {
      const matchTop = frameFilter.includes('top') && rec.frame === 'top';
      const matchOop = frameFilter.includes('oopif') && rec.frame !== 'top';
      const matchExact = frameFilter.some(f => f !== 'top' && f !== 'oopif' && rec.frame === f);
      if (!matchTop && !matchOop && !matchExact) return false;
    }
    return true;
  });

  const lastN = opts.all ? filtered.length
    : opts.last ? Math.max(1, parseInt(opts.last, 10) || DEFAULT_LAST_N)
    : DEFAULT_LAST_N;
  const shown = filtered.slice(-lastN);

  if (opts.json) {
    return JSON.stringify({
      total: all.length,
      filtered: filtered.length,
      dropped: buf.droppedCount,
      cap: buf.cap,
      shown: shown.length,
      records: shown,
    }, null, 2);
  }

  const counts = { GET: 0, POST: 0, OTHER: 0, failed: 0, '4xx': 0, '5xx': 0 };
  for (const r of all) {
    if (r.kind === 'boundary') continue;
    if (r.method === 'GET') counts.GET++;
    else if (r.method === 'POST') counts.POST++;
    else counts.OTHER++;
    if (r.state === 'failed') counts.failed++;
    if (r.status >= 400 && r.status < 500) counts['4xx']++;
    if (r.status >= 500 && r.status < 600) counts['5xx']++;
  }

  const headerParts = [
    `${pluralize(all.length, 'request')} captured (cap ${buf.cap})`,
    `${counts.GET} GET · ${counts.POST} POST · ${counts.OTHER} OTHER · ${counts.failed} failed · ${counts['4xx']} 4xx · ${counts['5xx']} 5xx`,
  ];
  if (buf.droppedCount > 0) headerParts.push(`${buf.droppedCount} earlier dropped`);
  if (filtered.length !== all.length) headerParts.push(`${filtered.length} match filter`);
  headerParts.push(`showing last ${shown.length}`);
  const header = headerParts.join(' · ') + '.';

  if (shown.length === 0) {
    return header + '\n(no requests)';
  }

  const rows = [
    ['REQ_ID', 'TIME', 'METHOD', 'STATUS', 'DURATION', 'SIZE', 'MIME', 'URL'].join('\t'),
  ];
  for (const rec of shown) {
    if (rec.kind === 'boundary') {
      rows.push(`--- navigation to ${rec.url || '<unknown>'} (buffer reset) ---`);
      continue;
    }
    const reqId = compactRequestId(rec.requestId);
    const t = formatTimestampMs(rec.startTime);
    const method = rec.hasPostData ? `${rec.method} Q` : rec.method;
    const status = rec.status != null ? String(rec.status) : (rec.state === 'pending' ? '—' : '—');
    const dur = rec.state === 'pending' ? '(pending)' : formatDurationMs(rec.durationMs);
    const size = formatSize(rec.size);
    const mime = rec.resMime || '—';
    const errSuffix = rec.errorText ? `   [failed: ${rec.errorText}]` : '';
    const frame = rec.frame && rec.frame !== 'top' ? ` [iframe]` : '';
    rows.push([reqId, t, method, status, dur, size, mime, rec.url + errSuffix + frame].join('\t'));
  }

  return [header, '', ...rows].join('\n');
}

/**
 * Fetch a request or response body for a given requestId prefix.
 * which: 'response' for body, 'request' for reqbody.
 */
async function netcaptureBodyStr(cdp, sessionMap, buf, requestIdPrefix, which, opts = {}) {
  if (!requestIdPrefix) throw new Error('requestId prefix required');
  const all = buf.snapshot().filter(r => r.kind !== 'boundary');
  const candidates = all
    .filter(r => compactRequestId(r.requestId).trim().toUpperCase().startsWith(String(requestIdPrefix).toUpperCase()))
    .map(r => r.requestId);
  if (candidates.length === 0) {
    throw new Error(`Unknown requestId '${requestIdPrefix}'. Run \`netcapture <target>\` to see active IDs.`);
  }
  if (new Set(candidates).size > 1) {
    throw new Error(`Ambiguous requestId prefix '${requestIdPrefix}' — matches ${candidates.length} requests. Use more characters.`);
  }
  const fullId = candidates[0];
  const rec = buf.findByRequestId(fullId);
  if (!rec) {
    throw new Error(`Request '${fullId}' is no longer in the buffer (dropped).`);
  }

  if (which === 'request' && !rec.hasPostData) {
    throw new Error(`Request '${requestIdPrefix}' had no body (method=${rec.method}, hasPostData=false).`);
  }

  const mime = which === 'response' ? rec.resMime : rec.reqMime;
  const isText = isTextMime(mime);
  const headBytes = opts.head ? parseInt(opts.head, 10) : null;
  const savePath = opts.save && opts.save !== true ? String(opts.save) : null;

  if (!isText && !headBytes && !savePath) {
    const sizeNote = rec.size ? ` (~${formatSize(rec.size)})` : '';
    throw new Error(`Body is binary (${mime || 'unknown MIME'}${sizeNote}). Pass --head <bytes> to peek or --save <path> to write to disk.`);
  }

  const sid = sessionMap.get(rec.frameSessionId) || sessionMap.get('top');
  let result;
  try {
    if (which === 'response') {
      result = await cdp.send('Network.getResponseBody', { requestId: fullId }, sid);
    } else {
      result = await cdp.send('Network.getRequestPostData', { requestId: fullId }, sid);
    }
  } catch (e) {
    if (/No data found|No resource with given identifier/i.test(e.message)) {
      throw new Error('Body no longer available — Chrome may have evicted it. Reload the page to recapture.');
    }
    throw e;
  }

  const raw = which === 'response'
    ? (result.base64Encoded ? Buffer.from(result.body || '', 'base64') : Buffer.from(result.body || '', 'utf8'))
    : Buffer.from(result.postData || '', 'utf8');

  if (savePath) {
    writeFileSync(savePath, raw);
    return `Saved ${raw.length} bytes to ${savePath} (${mime || 'unknown MIME'})`;
  }

  if (raw.length > BODY_FETCH_MAX_BYTES && !headBytes) {
    throw new Error(`Body is ${formatSize(raw.length)} (over the ${formatSize(BODY_FETCH_MAX_BYTES)} inline ceiling). Pass --head <bytes> to peek or --save <path> to write to disk.`);
  }

  let out = raw;
  let truncatedNote = '';
  if (headBytes && raw.length > headBytes) {
    out = raw.subarray(0, headBytes);
    truncatedNote = `\n…(truncated, +${raw.length - headBytes} bytes elided)`;
  }

  if (isText) {
    return out.toString('utf8') + truncatedNote;
  }
  // Binary + --head: emit a hex preview so the agent gets *something* useful
  // out of the bytes without nuking context with raw base64.
  const hex = Array.from(out).map(b => b.toString(16).padStart(2, '0')).join(' ');
  return `(binary, ${mime || 'unknown MIME'}, ${formatSize(raw.length)} total, showing first ${out.length} bytes as hex)\n${hex}${truncatedNote}`;
}

// ---------------------------------------------------------------------------
// storage — read browser storage (one-shot, no ring buffer)
// ---------------------------------------------------------------------------

async function storageStr(cdp, sid, opts = {}) {
  const only = parseCsvFilter(opts.only);
  const wants = (section) => !only || only.includes(section);
  const sections = [];

  // Resolve top-frame origin and security origin for DOMStorage.getDOMStorageItems.
  let origin = null;
  let securityOrigin = null;
  try {
    const tree = await cdp.send('Page.getFrameTree', {}, sid);
    origin = tree.frameTree?.frame?.url || null;
    if (origin) {
      try {
        securityOrigin = new URL(origin).origin;
      } catch { /* about:blank etc. */ }
    }
  } catch { /* fall through */ }

  if (wants('local')) {
    sections.push(`=== localStorage${origin ? ` (${origin})` : ''} ===`);
    if (securityOrigin) {
      try {
        await cdp.send('DOMStorage.enable', {}, sid);
        const { entries } = await cdp.send('DOMStorage.getDOMStorageItems', {
          storageId: { securityOrigin, isLocalStorage: true },
        }, sid);
        if (!entries || entries.length === 0) {
          sections.push('(empty)');
        } else {
          for (const [k, v] of entries) {
            const t = truncateString(String(v ?? ''), NETCAPTURE_RECORD_MAX_BYTES);
            sections.push(`${k} = ${t.value}`);
          }
        }
      } catch (e) {
        sections.push(`(unavailable: ${e.message})`);
      }
    } else {
      sections.push('(no top-frame origin)');
    }
    sections.push('');
  }

  if (wants('session')) {
    sections.push('=== sessionStorage ===');
    if (securityOrigin) {
      try {
        await cdp.send('DOMStorage.enable', {}, sid);
        const { entries } = await cdp.send('DOMStorage.getDOMStorageItems', {
          storageId: { securityOrigin, isLocalStorage: false },
        }, sid);
        if (!entries || entries.length === 0) {
          sections.push('(empty)');
        } else {
          for (const [k, v] of entries) {
            const t = truncateString(String(v ?? ''), NETCAPTURE_RECORD_MAX_BYTES);
            sections.push(`${k} = ${t.value}`);
          }
        }
      } catch (e) {
        sections.push(`(unavailable: ${e.message})`);
      }
    } else {
      sections.push('(no top-frame origin)');
    }
    sections.push('');
  }

  if (wants('cookies')) {
    try {
      const { cookies } = await cdp.send('Network.getCookies', {}, sid);
      sections.push(`=== cookies (${cookies?.length || 0}) ===`);
      if (!cookies || cookies.length === 0) {
        sections.push('(empty)');
      } else {
        for (const c of cookies) {
          const flags = [];
          if (c.httpOnly) flags.push('HttpOnly');
          if (c.secure) flags.push('Secure');
          if (c.sameSite) flags.push(`SameSite=${c.sameSite}`);
          if (c.session) flags.push('session');
          if (c.expires && c.expires > 0) flags.push(`expires=${new Date(c.expires * 1000).toISOString()}`);
          sections.push(`${c.name.padEnd(24)}  ${c.domain.padEnd(28)}  ${c.path.padEnd(8)}  ${flags.join('  ')}`);
        }
      }
    } catch (e) {
      sections.push('=== cookies ===');
      sections.push(`(unavailable: ${e.message})`);
    }
    sections.push('');
  }

  if (wants('indexeddb')) {
    sections.push('=== IndexedDB ===');
    if (securityOrigin) {
      try {
        await cdp.send('IndexedDB.enable', {}, sid);
        const { databaseNames } = await cdp.send('IndexedDB.requestDatabaseNames', {
          securityOrigin,
        }, sid);
        sections.push((databaseNames && databaseNames.length) ? databaseNames.join(', ') : '(empty)');
      } catch (e) {
        sections.push(`(unavailable: ${e.message})`);
      }
    } else {
      sections.push('(no top-frame origin)');
    }
    sections.push('');
  }

  if (opts.json) {
    return JSON.stringify({ origin, securityOrigin, output: sections.join('\n') }, null, 2);
  }
  return sections.join('\n').trimEnd();
}

// ---------------------------------------------------------------------------
// waitfor / waitgone — block until a selector matches (or doesn't)
// ---------------------------------------------------------------------------

async function waitForSelector(cdp, sid, selector, opts = {}) {
  if (!selector) throw new Error('CSS selector required');
  const timeout = parseDurationToMs(opts.timeout, WAITFOR_DEFAULT_TIMEOUT);
  const wantVisible = !!opts.visible;
  const wantGone = !!opts.gone;
  const deadline = Date.now() + timeout;
  const sel = JSON.stringify(selector);
  const probe = wantVisible
    ? `(function(){const el=document.querySelector(${sel});return !!(el && el.offsetParent !== null);})()`
    : `!!document.querySelector(${sel})`;

  while (Date.now() < deadline) {
    let exists;
    try {
      const raw = await evalStr(cdp, sid, probe);
      exists = raw === 'true';
    } catch {
      exists = false;
    }
    if (wantGone ? !exists : exists) {
      const action = wantGone ? 'gone' : 'present';
      return `Selector ${selector} ${action} after ${Date.now() - (deadline - timeout)}ms`;
    }
    await sleep(WAITFOR_POLL_INTERVAL);
  }
  throw new Error(`Timed out after ${timeout}ms waiting for selector ${selector} to be ${wantGone ? 'gone' : (wantVisible ? 'visible' : 'present')}`);
}

// ---------------------------------------------------------------------------
// Per-tab daemon
// ---------------------------------------------------------------------------

async function runDaemon(targetId) {
  const sp = sockPath(targetId);

  const cdp = new CDP();
  try {
    await cdp.connect(await getWsUrl());
  } catch (e) {
    process.stderr.write(`Daemon: cannot connect to Chrome: ${e.message}\n`);
    process.exit(1);
  }

  let sessionId;
  try {
    const res = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    sessionId = res.sessionId;
  } catch (e) {
    process.stderr.write(`Daemon: attach failed: ${e.message}\n`);
    cdp.close();
    process.exit(1);
  }

  // Shutdown helpers
  let alive = true;
  function shutdown() {
    if (!alive) return;
    alive = false;
    server.close();
    if (!IS_WINDOWS) try { unlinkSync(sp); } catch {}
    cdp.close();
    process.exit(0);
  }

  // Exit if target goes away or Chrome disconnects
  cdp.onEvent('Target.targetDestroyed', (params) => {
    if (params.targetId === targetId) shutdown();
  });
  cdp.onEvent('Target.detachedFromTarget', (params) => {
    if (params.sessionId === sessionId) shutdown();
  });
  cdp.onClose(() => shutdown());
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // ----- Console + netcapture buffers and event wiring ---------------------

  const consoleBuf = new RingBuffer(CONSOLE_BUFFER_CAP);
  const netBuf = new NetcaptureBuffer(NETCAPTURE_BUFFER_CAP);

  // sessionId -> { frame: 'top' | <url>, type: 'page' | 'iframe' }
  const sessionMap = new Map();
  sessionMap.set(sessionId, { frame: 'top', type: 'page' });

  async function enableCaptureOnSession(sid) {
    try { await cdp.send('Runtime.enable', {}, sid); } catch {}
    try { await cdp.send('Log.enable', {}, sid); } catch {}
    try { await cdp.send('Network.enable', {}, sid); } catch {}
    try { await cdp.send('Page.enable', {}, sid); } catch {}
    try {
      await cdp.send('Target.setAutoAttach', {
        autoAttach: true,
        flatten: true,
        waitForDebuggerOnStart: false,
      }, sid);
    } catch {}
  }

  // Top-frame setup. Best-effort — some target types (devtools://, chrome://)
  // refuse one or more of these; we log nothing and let the relevant commands
  // surface an empty buffer instead.
  await enableCaptureOnSession(sessionId);

  cdp.onEvent('Target.attachedToTarget', async (params) => {
    const childSid = params.sessionId;
    const target = params.targetInfo;
    if (!childSid || !target) return;
    if (target.type !== 'iframe') return;
    sessionMap.set(childSid, { frame: target.url || '(iframe)', type: 'iframe' });
    await enableCaptureOnSession(childSid);
  });

  cdp.onEvent('Target.detachedFromTarget', (params) => {
    if (params.sessionId && params.sessionId !== sessionId) {
      sessionMap.delete(params.sessionId);
    }
  });

  cdp.onEvent('Runtime.consoleAPICalled', (params, msg) => {
    const meta = sessionMap.get(msg.sessionId);
    if (!meta) return;
    const text = (params.args || []).map(formatRemoteObject).join(' ');
    const trunc = truncateString(text, CONSOLE_RECORD_MAX_BYTES);
    const stack = formatStackTrace(params.stackTrace);
    const lvl = params.type === 'error' ? 'error'
      : params.type === 'warning' ? 'warn'
      : params.type === 'info' ? 'info'
      : params.type === 'debug' || params.type === 'trace' ? 'debug'
      : 'log';
    consoleBuf.push({
      ts: Math.round(params.timestamp || Date.now()),
      source: 'console',
      level: lvl,
      text: trunc.value,
      frame: meta.frame,
      stack,
    });
  });

  cdp.onEvent('Runtime.exceptionThrown', (params, msg) => {
    const meta = sessionMap.get(msg.sessionId);
    if (!meta) return;
    const d = params.exceptionDetails;
    const text = formatExceptionDetails(d);
    const trunc = truncateString(text, CONSOLE_RECORD_MAX_BYTES);
    const stack = formatStackTrace(d?.stackTrace);
    consoleBuf.push({
      ts: Math.round(params.timestamp || Date.now()),
      source: 'exception',
      level: 'error',
      text: trunc.value,
      frame: meta.frame,
      stack,
    });
  });

  cdp.onEvent('Log.entryAdded', (params, msg) => {
    const meta = sessionMap.get(msg.sessionId);
    if (!meta) return;
    const e = params.entry || {};
    const level = e.level === 'error' ? 'error'
      : e.level === 'warning' ? 'warn'
      : e.level === 'info' ? 'info'
      : e.level === 'verbose' ? 'debug'
      : 'log';
    const text = e.url ? `${e.text || ''} (${e.url})` : (e.text || '');
    const trunc = truncateString(text, CONSOLE_RECORD_MAX_BYTES);
    consoleBuf.push({
      ts: e.timestamp ? Math.round(e.timestamp) : Date.now(),
      source: 'log',
      level,
      text: trunc.value,
      frame: meta.frame,
      stack: null,
    });
  });

  cdp.onEvent('Network.requestWillBeSent', (params, msg) => {
    const meta = sessionMap.get(msg.sessionId);
    if (!meta) return;
    const req = params.request || {};
    const headers = req.headers || {};
    const reqMime = headers['Content-Type'] || headers['content-type'] || null;
    const wallMs = params.wallTime ? Math.round(params.wallTime * 1000) : Date.now();
    const url = truncateString(req.url || '', NETCAPTURE_RECORD_MAX_BYTES).value;
    netBuf.push({
      requestId: params.requestId,
      method: req.method || 'GET',
      url,
      status: null,
      reqMime,
      resMime: null,
      hasPostData: !!req.hasPostData,
      startTime: wallMs,
      endTime: null,
      durationMs: null,
      size: null,
      fromCache: false,
      errorText: null,
      frame: meta.frame,
      frameSessionId: msg.sessionId,
      state: 'pending',
    });
  });

  cdp.onEvent('Network.responseReceived', (params) => {
    const rec = netBuf.findByRequestId(params.requestId);
    if (!rec) return;
    const r = params.response || {};
    rec.status = r.status ?? null;
    rec.resMime = r.mimeType || null;
    rec.fromCache = !!r.fromDiskCache || !!r.fromServiceWorker;
  });

  cdp.onEvent('Network.loadingFinished', (params) => {
    const rec = netBuf.findByRequestId(params.requestId);
    if (!rec) return;
    const now = Date.now();
    rec.endTime = now;
    rec.durationMs = rec.startTime ? now - rec.startTime : null;
    rec.size = params.encodedDataLength ?? rec.size;
    rec.state = 'done';
  });

  cdp.onEvent('Network.loadingFailed', (params) => {
    const rec = netBuf.findByRequestId(params.requestId);
    if (!rec) return;
    const now = Date.now();
    rec.endTime = now;
    rec.durationMs = rec.startTime ? now - rec.startTime : null;
    rec.errorText = params.errorText || 'unknown error';
    rec.state = 'failed';
  });

  cdp.onEvent('Page.frameNavigated', (params, msg) => {
    if (msg.sessionId !== sessionId) return;
    if (params.frame?.parentId) return;
    const url = params.frame?.url || null;
    consoleBuf.markNavigation(url);
    netBuf.markNavigation(url);
  });

  // Idle timer
  let idleTimer = setTimeout(shutdown, IDLE_TIMEOUT);
  function resetIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(shutdown, IDLE_TIMEOUT);
  }

  // Handle a command
  async function handleCommand({ cmd, args }) {
    resetIdle();
    try {
      let result;
      switch (cmd) {
        case 'list': {
          const pages = await getPages(cdp);
          result = formatPageList(pages);
          break;
        }
        case 'list_raw': {
          const pages = await getPages(cdp);
          result = JSON.stringify(pages);
          break;
        }
        case 'snap': case 'snapshot': result = await snapshotStr(cdp, sessionId, true); break;
        case 'eval': result = await evalStr(cdp, sessionId, args[0]); break;
        case 'shot': case 'screenshot': {
          // args: [filePath?, optsJson?]
          const shotOpts = args[1] ? safeJsonParse(args[1]) : {};
          result = await shotStr(cdp, sessionId, args[0] || null, targetId, shotOpts);
          break;
        }
        case 'html': result = await htmlStr(cdp, sessionId, args[0]); break;
        case 'nav': case 'navigate': result = await navStr(cdp, sessionId, args[0]); break;
        case 'net': case 'network': result = await netStr(cdp, sessionId); break;
        case 'click': result = await clickStr(cdp, sessionId, args[0]); break;
        case 'clickxy': result = await clickXyStr(cdp, sessionId, args[0], args[1]); break;
        case 'type': result = await typeStr(cdp, sessionId, args[0]); break;
        case 'loadall': result = await loadAllStr(cdp, sessionId, args[0], args[1] ? parseInt(args[1]) : 1500); break;
        case 'evalraw': result = await evalRawStr(cdp, sessionId, args[0], args[1]); break;
        case 'console': {
          // args: [sub?, optsJson?]
          const sub = args[0] || '';
          if (sub === 'clear') { consoleBuf.clear(); result = 'Console buffer cleared.'; break; }
          const opts = sub && sub.startsWith('{') ? safeJsonParse(sub) : (args[1] ? safeJsonParse(args[1]) : {});
          result = consoleStr(consoleBuf, opts);
          break;
        }
        case 'netcapture': {
          // args: [sub, ...]
          const sub = args[0] || '';
          if (sub === 'clear') { netBuf.clear(); result = 'Netcapture buffer cleared.'; break; }
          if (sub === 'body' || sub === 'reqbody') {
            const which = sub === 'body' ? 'response' : 'request';
            const reqIdPrefix = args[1];
            const opts = args[2] ? safeJsonParse(args[2]) : {};
            result = await netcaptureBodyStr(cdp, sessionMap, netBuf, reqIdPrefix, which, opts);
            break;
          }
          const opts = sub && sub.startsWith('{') ? safeJsonParse(sub) : (args[1] ? safeJsonParse(args[1]) : {});
          result = netcaptureListStr(netBuf, opts);
          break;
        }
        case 'storage': {
          const opts = args[0] ? safeJsonParse(args[0]) : {};
          result = await storageStr(cdp, sessionId, opts);
          break;
        }
        case 'waitfor': {
          const opts = args[1] ? safeJsonParse(args[1]) : {};
          result = await waitForSelector(cdp, sessionId, args[0], opts);
          break;
        }
        case 'waitgone': {
          const opts = args[1] ? safeJsonParse(args[1]) : {};
          result = await waitForSelector(cdp, sessionId, args[0], { ...opts, gone: true });
          break;
        }
        case 'stop': return { ok: true, result: '', stopAfter: true };
        default: return { ok: false, error: `Unknown command: ${cmd}` };
      }
      return { ok: true, result: result ?? '' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // Unix socket server — NDJSON protocol
  // Wire format: each message is one JSON object followed by \n (newline-delimited JSON).
  // Request:  { "id": <number>, "cmd": "<command>", "args": ["arg1", "arg2", ...] }
  // Response: { "id": <number>, "ok": <boolean>, "result": "<string>" }
  //           or { "id": <number>, "ok": false, "error": "<message>" }
  const server = net.createServer((conn) => {
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop(); // keep incomplete last line
      for (const line of lines) {
        if (!line.trim()) continue;
        let req;
        try {
          req = JSON.parse(line);
        } catch {
          conn.write(JSON.stringify({ ok: false, error: 'Invalid JSON request', id: null }) + '\n');
          continue;
        }
        handleCommand(req).then((res) => {
          const payload = JSON.stringify({ ...res, id: req.id }) + '\n';
          if (res.stopAfter) conn.end(payload, shutdown);
          else conn.write(payload);
        });
      }
    });
  });

  server.on('error', (e) => {
    process.stderr.write(`Daemon server listen failed: ${e.message}\n`);
    process.exit(1);
  });

  if (!IS_WINDOWS) try { unlinkSync(sp); } catch {}
  server.listen(sp);
}

// ---------------------------------------------------------------------------
// CLI ↔ daemon communication
// ---------------------------------------------------------------------------

function connectToSocket(sp) {
  return new Promise((resolve, reject) => {
    const conn = net.connect(sp);
    conn.on('connect', () => resolve(conn));
    conn.on('error', reject);
  });
}

async function getOrStartTabDaemon(targetId) {
  const sp = sockPath(targetId);
  // Try existing daemon
  try { return await connectToSocket(sp); } catch {}

  // Clean stale socket
  if (!IS_WINDOWS) try { unlinkSync(sp); } catch {}

  // Pre-flight: confirm Chrome remote-debug is reachable before spawning
  // the detached daemon. Daemons run with stdio: 'ignore', so an error
  // thrown during their startup would otherwise be invisible — the CLI
  // would only see "Daemon failed to start" after a 6s wait. Probing
  // here lets us surface the real error (Chrome closed, debugging off,
  // stale port file, etc.) immediately.
  await getWsUrl();

  // Spawn daemon
  const child = spawn(process.execPath, [process.argv[1], '_daemon', targetId], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  // Wait for socket (includes time for user to click Allow)
  for (let i = 0; i < DAEMON_CONNECT_RETRIES; i++) {
    await sleep(DAEMON_CONNECT_DELAY);
    try { return await connectToSocket(sp); } catch {}
  }
  throw new Error('Daemon failed to start — did you click Allow in Chrome?');
}

function sendCommand(conn, req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    let settled = false;

    const cleanup = () => {
      conn.off('data', onData);
      conn.off('error', onError);
      conn.off('end', onEnd);
      conn.off('close', onClose);
    };

    const onData = (chunk) => {
      buf += chunk.toString();
      const idx = buf.indexOf('\n');
      if (idx === -1) return;
      settled = true;
      cleanup();
      resolve(JSON.parse(buf.slice(0, idx)));
      conn.end();
    };

    const onError = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Connection closed before response'));
    };

    const onClose = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Connection closed before response'));
    };

    conn.on('data', onData);
    conn.on('error', onError);
    conn.on('end', onEnd);
    conn.on('close', onClose);
    req.id = 1;
    conn.write(JSON.stringify(req) + '\n');
  });
}

// ---------------------------------------------------------------------------
// Stop daemons
// ---------------------------------------------------------------------------

async function stopDaemons(targetPrefix) {
  if (!existsSync(PAGES_CACHE)) return;
  const pages = JSON.parse(readFileSync(PAGES_CACHE, 'utf8'));
  const targets = targetPrefix
    ? [resolvePrefix(targetPrefix, pages.map(p => p.targetId), 'target')]
    : pages.map(p => p.targetId);

  for (const targetId of targets) {
    const sp = sockPath(targetId);
    try {
      const conn = await connectToSocket(sp);
      await sendCommand(conn, { cmd: 'stop' });
    } catch {
      if (!IS_WINDOWS) try { unlinkSync(sp); } catch {}
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const USAGE = `cdp - lightweight Chrome DevTools Protocol CLI (no Puppeteer)

Usage: cdp <command> [args]

  list                              List open pages (shows unique target prefixes)
  snap  <target>                    Accessibility tree snapshot
  eval  <target> <expr>             Evaluate JS expression
  shot  <target> [file] [--full]    Screenshot. --full captures the entire scrollable page.
                                    Default file: screenshot-<target>[-full].png in runtime dir.
  html  <target> [selector]         Get HTML (full page or CSS selector)
  nav   <target> <url>              Navigate to URL and wait for load completion
  net   <target>                    Page-side resource timing (performance.getEntriesByType)
                                    For full request/response capture, use netcapture.
  click   <target> <selector>       Click an element by CSS selector
  clickxy <target> <x> <y>          Click at CSS pixel coordinates (see coordinate note below)
  type    <target> <text>           Type text at current focus via Input.insertText
                                    Works in cross-origin iframes unlike eval-based approaches
  loadall <target> <selector> [ms]  Repeatedly click a "load more" button until it disappears
                                    Optional interval in ms between clicks (default 1500)
  evalraw <target> <method> [json]  Send a raw CDP command; returns JSON result

  console <target> [flags]          Buffered console / exception / log entries.
                                    Flags: --last N, --all, --since <iso|5m|1h>,
                                           --level error,warn,info,log,debug,
                                           --frame top|oopif|<url>, --json
  console <target> clear            Clear the console buffer

  netcapture <target> [flags]       Buffered HTTP request/response history.
                                    Flags: --last N, --all, --since <dur>,
                                           --status 4xx,5xx,404 --method POST,GET
                                           --mime json --url-contains "/api/"
                                           --url-regex "^https://api\\." --json
  netcapture <target> body <reqId> [--head N] [--save <path>]
                                    Fetch response body. Text inline, binary needs --head/--save.
  netcapture <target> reqbody <reqId> [--head N] [--save <path>]
                                    Fetch request (POST) body, same rules as body.
  netcapture <target> clear         Clear the netcapture buffer

  storage <target> [--only local,session,cookies,indexeddb] [--json]
                                    Read localStorage / sessionStorage / cookies / IndexedDB names.

  waitfor  <target> <selector> [--timeout 10s] [--visible]
                                    Block until selector matches (and is visible, if requested).
  waitgone <target> <selector> [--timeout 10s]
                                    Block until selector matches zero elements.

  open  [url]                       Open a new tab (default: about:blank)
                                    Note: each new tab triggers a fresh "Allow debugging?" prompt
  stop  [target]                    Stop daemon(s)

<target> is a unique targetId prefix from "cdp list". If a prefix is ambiguous,
use more characters.

COORDINATE SYSTEM
  shot captures the viewport at the device's native resolution.
  The screenshot image size = CSS pixels × DPR (device pixel ratio).
  For CDP Input events (clickxy, etc.) you need CSS pixels, not image pixels.

    CSS pixels = screenshot image pixels / DPR

  shot prints the DPR and an example conversion for the current page.
  Typical Retina (DPR=2): CSS px ≈ screenshot px × 0.5
  If your viewer rescales the image further, account for that scaling too.

EVAL SAFETY NOTE
  Avoid index-based DOM selection (querySelectorAll(...)[i]) across multiple
  eval calls when the list can change between calls (e.g. after clicking
  "Ignore" buttons on a feed — indices shift). Prefer stable selectors or
  collect all data in a single eval.

DAEMON IPC (for advanced use / scripting)
  Each tab runs a persistent daemon at Unix socket in the runtime dir (see below).
  Protocol: newline-delimited JSON (one JSON object per line, UTF-8).
    Request:  {"id":<number>, "cmd":"<command>", "args":["arg1","arg2",...]}
    Response: {"id":<number>, "ok":true,  "result":"<string>"}
           or {"id":<number>, "ok":false, "error":"<message>"}
  Commands mirror the CLI: snap, eval, shot, html, nav, net, click, clickxy,
  type, loadall, evalraw, stop. Use evalraw to send arbitrary CDP methods.
  The socket disappears after 20 min of inactivity or when the tab closes.
`;

const NEEDS_TARGET = new Set([
  'snap','snapshot','eval','shot','screenshot','html','nav','navigate',
  'net','network','click','clickxy','type','loadall','evalraw',
  'console','netcapture','storage','waitfor','waitgone',
]);

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  // Daemon mode (internal)
  if (cmd === '_daemon') { await runDaemon(args[0]); return; }

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(USAGE); process.exit(0);
  }

  if (cmd === 'list' || cmd === 'ls') {
    const cdp = new CDP();
    await cdp.connect(await getWsUrl());
    const pages = await getPages(cdp);
    cdp.close();
    writeFileSync(PAGES_CACHE, JSON.stringify(pages), { mode: 0o600 });
    console.log(formatPageList(pages));
    setTimeout(() => process.exit(0), 100);
    return;
  }

  // Open new tab
  if (cmd === 'open') {
    const url = args[0] || 'about:blank';
    const cdp = new CDP();
    await cdp.connect(await getWsUrl());
    const { targetId } = await cdp.send('Target.createTarget', { url });
    // Refresh cache; new tab may not appear in getTargets immediately, so add it manually
    const pages = await getPages(cdp);
    if (!pages.some(p => p.targetId === targetId)) {
      pages.push({ targetId, title: url, url });
    }
    cdp.close();
    writeFileSync(PAGES_CACHE, JSON.stringify(pages), { mode: 0o600 });
    console.log(`Opened new tab: ${targetId.slice(0, 8)}  ${url}`);
    console.log('Note: this tab will need "Allow debugging?" approval on first access.');
    return;
  }

  // Stop
  if (cmd === 'stop') {
    await stopDaemons(args[0]);
    return;
  }

  // Page commands — need target prefix
  if (!NEEDS_TARGET.has(cmd)) {
    console.error(`Unknown command: ${cmd}\n`);
    console.log(USAGE);
    process.exit(1);
  }

  const targetPrefix = args[0];
  if (!targetPrefix) {
    console.error('Error: target ID required. Run "cdp list" first.');
    process.exit(1);
  }

  // Resolve prefix → full targetId from pages cache
  if (!existsSync(PAGES_CACHE)) {
    console.error('No page list cached. Run "cdp list" first.');
    process.exit(1);
  }
  const pages = JSON.parse(readFileSync(PAGES_CACHE, 'utf8'));
  const targetId = resolvePrefix(targetPrefix, pages.map(p => p.targetId), 'target', 'Run "cdp list".');

  const conn = await getOrStartTabDaemon(targetId);

  const cmdArgs = args.slice(1);

  let daemonArgs = cmdArgs;

  if (cmd === 'eval') {
    const expr = cmdArgs.join(' ');
    if (!expr) { console.error('Error: expression required'); process.exit(1); }
    daemonArgs = [expr];
  } else if (cmd === 'type') {
    // Join all remaining args as text (allows spaces)
    const text = cmdArgs.join(' ');
    if (!text) { console.error('Error: text required'); process.exit(1); }
    daemonArgs = [text];
  } else if (cmd === 'evalraw') {
    if (!cmdArgs[0]) { console.error('Error: CDP method required'); process.exit(1); }
    if (cmdArgs.length > 2) cmdArgs[1] = cmdArgs.slice(1).join(' ');
    daemonArgs = cmdArgs.slice(0, 2);
  } else if (cmd === 'shot' || cmd === 'screenshot') {
    // shot <target> [file] [--full]
    const { flags, positional } = parseFlags(cmdArgs);
    daemonArgs = [positional[0] || null, JSON.stringify(flags)];
  } else if (cmd === 'console') {
    // console <target> [clear] [--last N --level a,b --since X --frame top|oopif --json --all]
    const { flags, positional } = parseFlags(cmdArgs);
    if (positional[0] === 'clear') {
      daemonArgs = ['clear'];
    } else {
      daemonArgs = [JSON.stringify(flags)];
    }
  } else if (cmd === 'netcapture') {
    // netcapture <target> [clear|body <id>|reqbody <id>] [flags]
    const { flags, positional } = parseFlags(cmdArgs);
    if (positional[0] === 'clear') {
      daemonArgs = ['clear'];
    } else if (positional[0] === 'body' || positional[0] === 'reqbody') {
      if (!positional[1]) {
        console.error(`Error: ${positional[0]} requires a requestId prefix`);
        process.exit(1);
      }
      daemonArgs = [positional[0], positional[1], JSON.stringify(flags)];
    } else {
      daemonArgs = [JSON.stringify(flags)];
    }
  } else if (cmd === 'storage') {
    const { flags } = parseFlags(cmdArgs);
    daemonArgs = [JSON.stringify(flags)];
  } else if (cmd === 'waitfor' || cmd === 'waitgone') {
    // waitfor <target> "<selector>" [--timeout 10s] [--visible]
    const { flags, positional } = parseFlags(cmdArgs);
    if (!positional[0]) {
      console.error('Error: selector required');
      process.exit(1);
    }
    daemonArgs = [positional[0], JSON.stringify(flags)];
  }

  if ((cmd === 'nav' || cmd === 'navigate') && !daemonArgs[0]) {
    console.error('Error: URL required');
    process.exit(1);
  }

  const response = await sendCommand(conn, { cmd, args: daemonArgs });

  if (response.ok) {
    if (response.result) console.log(response.result);
  } else {
    console.error('Error:', response.error);
    process.exitCode = 1;
  }
}

// Auto-run when executed directly. Stays a no-op when imported (e.g. from
// tests that need access to the internal buffer/formatter helpers).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}

export {
  RingBuffer,
  NetcaptureBuffer,
  consoleStr,
  netcaptureListStr,
  formatRemoteObject,
  formatExceptionDetails,
  formatStackTrace,
  truncateString,
  parseSince,
  parseDurationToMs,
  parseStatusFilter,
  parseFlags,
  isTextMime,
  compactRequestId,
  CONSOLE_BUFFER_CAP,
  NETCAPTURE_BUFFER_CAP,
  CONSOLE_RECORD_MAX_BYTES,
  NETCAPTURE_RECORD_MAX_BYTES,
  DEFAULT_LAST_N,
  BODY_FETCH_MAX_BYTES,
};
