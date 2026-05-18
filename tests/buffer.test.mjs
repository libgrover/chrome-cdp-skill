/**
 * Buffer + filter + formatter unit tests.
 *
 * Pure data tests — no Chrome required. Feeds synthetic records through the
 * ring-buffer module to catch ring-arithmetic regressions, filter logic, and
 * truncation edge cases.
 *
 * Run: node --test tests/buffer.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RingBuffer,
  NetcaptureBuffer,
  consoleStr,
  netcaptureListStr,
  truncateString,
  parseSince,
  parseDurationToMs,
  parseStatusFilter,
  parseFlags,
  isTextMime,
  compactRequestId,
  CONSOLE_RECORD_MAX_BYTES,
} from '../skills/chrome-cdp/scripts/cdp.mjs';

// ---------------------------------------------------------------------------
// RingBuffer

test('RingBuffer drops oldest when at cap', () => {
  const buf = new RingBuffer(3);
  buf.push({ ts: 1, text: 'a' });
  buf.push({ ts: 2, text: 'b' });
  buf.push({ ts: 3, text: 'c' });
  buf.push({ ts: 4, text: 'd' });

  const snap = buf.snapshot();
  assert.equal(snap.length, 3);
  assert.equal(snap[0].text, 'b');
  assert.equal(snap[2].text, 'd');
  assert.equal(buf.droppedCount, 1);
});

test('RingBuffer dropped count grows across many drops', () => {
  const buf = new RingBuffer(2);
  for (let i = 0; i < 10; i++) buf.push({ ts: i, text: String(i) });
  assert.equal(buf.snapshot().length, 2);
  assert.equal(buf.droppedCount, 8);
});

test('RingBuffer.clear resets records and dropped count', () => {
  const buf = new RingBuffer(2);
  buf.push({ ts: 1 });
  buf.push({ ts: 2 });
  buf.push({ ts: 3 }); // drops 1
  assert.equal(buf.droppedCount, 1);
  buf.clear();
  assert.equal(buf.snapshot().length, 0);
  assert.equal(buf.droppedCount, 0);
});

test('RingBuffer.markNavigation inserts a boundary record and resets dropped', () => {
  const buf = new RingBuffer(5);
  buf.push({ ts: 1, text: 'pre' });
  buf.push({ ts: 2, text: 'pre2' });
  buf.markNavigation('https://example.com/');
  const snap = buf.snapshot();
  assert.equal(snap.length, 1);
  assert.equal(snap[0].kind, 'boundary');
  assert.equal(snap[0].url, 'https://example.com/');
  assert.equal(buf.droppedCount, 0);
});

// ---------------------------------------------------------------------------
// NetcaptureBuffer

test('NetcaptureBuffer indexes by requestId for O(1) lookup', () => {
  const buf = new NetcaptureBuffer(5);
  buf.push({ requestId: 'AAA', method: 'GET', url: '/a', startTime: 1, state: 'pending' });
  buf.push({ requestId: 'BBB', method: 'POST', url: '/b', startTime: 2, state: 'pending' });
  const found = buf.findByRequestId('BBB');
  assert.equal(found.url, '/b');
});

test('NetcaptureBuffer rebuilds index after eviction', () => {
  const buf = new NetcaptureBuffer(2);
  buf.push({ requestId: 'AAA', method: 'GET', url: '/a', startTime: 1, state: 'pending' });
  buf.push({ requestId: 'BBB', method: 'GET', url: '/b', startTime: 2, state: 'pending' });
  buf.push({ requestId: 'CCC', method: 'GET', url: '/c', startTime: 3, state: 'pending' });
  assert.equal(buf.findByRequestId('AAA'), null);
  assert.equal(buf.findByRequestId('BBB').url, '/b');
  assert.equal(buf.findByRequestId('CCC').url, '/c');
});

test('NetcaptureBuffer.markNavigation clears records AND index', () => {
  const buf = new NetcaptureBuffer(5);
  buf.push({ requestId: 'AAA', method: 'GET', url: '/a', startTime: 1, state: 'pending' });
  buf.markNavigation('https://example.com/');
  assert.equal(buf.findByRequestId('AAA'), null);
});

// ---------------------------------------------------------------------------
// truncateString

test('truncateString returns input unchanged when under cap', () => {
  const r = truncateString('hello', 100);
  assert.equal(r.value, 'hello');
  assert.equal(r.truncated, false);
});

test('truncateString truncates and notes elision', () => {
  const big = 'x'.repeat(CONSOLE_RECORD_MAX_BYTES + 100);
  const r = truncateString(big, CONSOLE_RECORD_MAX_BYTES);
  assert.equal(r.truncated, true);
  assert.match(r.value, /…\(truncated, \+100 bytes elided\)$/);
});

// ---------------------------------------------------------------------------
// parseSince

test('parseSince accepts relative durations', () => {
  const now = Date.now();
  const five = parseSince('5m');
  assert.ok(five <= now);
  assert.ok(five >= now - 6 * 60 * 1000);
});

test('parseSince accepts ISO 8601', () => {
  const t = parseSince('2025-01-01T00:00:00Z');
  assert.equal(t, Date.parse('2025-01-01T00:00:00Z'));
});

test('parseSince returns null on garbage', () => {
  assert.equal(parseSince('not a date'), null);
  assert.equal(parseSince(''), null);
  assert.equal(parseSince(null), null);
});

// ---------------------------------------------------------------------------
// parseDurationToMs

test('parseDurationToMs handles ms/s/m/h units', () => {
  assert.equal(parseDurationToMs('500ms', 9999), 500);
  assert.equal(parseDurationToMs('10s', 9999), 10000);
  assert.equal(parseDurationToMs('2m', 9999), 120000);
  assert.equal(parseDurationToMs('1h', 9999), 3600000);
});

test('parseDurationToMs treats bare numbers as ms', () => {
  assert.equal(parseDurationToMs('12345', 9999), 12345);
});

test('parseDurationToMs falls back on garbage', () => {
  assert.equal(parseDurationToMs('not a duration', 42), 42);
  assert.equal(parseDurationToMs(undefined, 42), 42);
});

// ---------------------------------------------------------------------------
// parseStatusFilter

test('parseStatusFilter supports family shorthand', () => {
  const f = parseStatusFilter('4xx,5xx');
  assert.equal(f(404), true);
  assert.equal(f(422), true);
  assert.equal(f(500), true);
  assert.equal(f(200), false);
  assert.equal(f(301), false);
});

test('parseStatusFilter supports specific codes', () => {
  const f = parseStatusFilter('404,500');
  assert.equal(f(404), true);
  assert.equal(f(500), true);
  assert.equal(f(403), false);
});

test('parseStatusFilter mixes families and specific codes', () => {
  const f = parseStatusFilter('4xx,500');
  assert.equal(f(404), true);
  assert.equal(f(500), true);
  assert.equal(f(502), false);
});

test('parseStatusFilter returns null on empty input', () => {
  assert.equal(parseStatusFilter(''), null);
  assert.equal(parseStatusFilter(null), null);
});

// ---------------------------------------------------------------------------
// parseFlags

test('parseFlags pairs --key value', () => {
  const { flags, positional } = parseFlags(['--last', '50', '--json', '--level', 'error,warn']);
  assert.equal(flags.last, '50');
  assert.equal(flags.json, true);
  assert.equal(flags.level, 'error,warn');
  assert.deepEqual(positional, []);
});

test('parseFlags peels positional args off the front', () => {
  const { flags, positional } = parseFlags(['body', 'A3F1', '--head', '4096']);
  assert.deepEqual(positional, ['body', 'A3F1']);
  assert.equal(flags.head, '4096');
});

// ---------------------------------------------------------------------------
// isTextMime + compactRequestId

test('isTextMime covers text/* and JSON/XML variants', () => {
  assert.equal(isTextMime('text/html'), true);
  assert.equal(isTextMime('application/json'), true);
  assert.equal(isTextMime('application/vnd.api+json'), true);
  assert.equal(isTextMime('application/javascript'), true);
  assert.equal(isTextMime('application/xml'), true);
  assert.equal(isTextMime('image/png'), false);
  assert.equal(isTextMime('application/octet-stream'), false);
  assert.equal(isTextMime(null), false);
});

test('compactRequestId strips the session prefix and pads', () => {
  assert.equal(compactRequestId('F2A3B7C9.42').trim(), '42');
  assert.equal(compactRequestId('ABCDEFGH01234'), 'ABCDEFGH');
});

// ---------------------------------------------------------------------------
// consoleStr — end-to-end through formatter

test('consoleStr produces a summary + records', () => {
  const buf = new RingBuffer(10);
  buf.push({ ts: Date.now(), source: 'console', level: 'log', text: 'hi', frame: 'top', stack: null });
  buf.push({ ts: Date.now(), source: 'console', level: 'warn', text: 'careful', frame: 'top', stack: null });
  buf.push({ ts: Date.now(), source: 'exception', level: 'error', text: 'boom', frame: 'top', stack: '  at foo' });
  const out = consoleStr(buf);
  assert.match(out, /3 messages buffered/);
  assert.match(out, /hi/);
  assert.match(out, /careful/);
  assert.match(out, /boom/);
});

test('consoleStr --level filters by level', () => {
  const buf = new RingBuffer(10);
  buf.push({ ts: Date.now(), source: 'console', level: 'log', text: 'a', frame: 'top', stack: null });
  buf.push({ ts: Date.now(), source: 'console', level: 'error', text: 'b', frame: 'top', stack: null });
  const out = consoleStr(buf, { level: 'error' });
  assert.doesNotMatch(out, /(^| )a( |$)/m);
  assert.match(out, /b/);
});

test('consoleStr --json emits parseable JSON', () => {
  const buf = new RingBuffer(10);
  buf.push({ ts: 123, source: 'console', level: 'log', text: 'a', frame: 'top', stack: null });
  const out = consoleStr(buf, { json: true });
  const parsed = JSON.parse(out);
  assert.equal(parsed.total, 1);
  assert.equal(parsed.records[0].text, 'a');
});

test('consoleStr drops are surfaced in the header', () => {
  const buf = new RingBuffer(2);
  buf.push({ ts: 1, source: 'console', level: 'log', text: 'old', frame: 'top', stack: null });
  buf.push({ ts: 2, source: 'console', level: 'log', text: 'newer', frame: 'top', stack: null });
  buf.push({ ts: 3, source: 'console', level: 'log', text: 'newest', frame: 'top', stack: null });
  const out = consoleStr(buf);
  assert.match(out, /1 earlier dropped/);
});

// ---------------------------------------------------------------------------
// netcaptureListStr — filter composition

test('netcaptureListStr renders a row per request', () => {
  const buf = new NetcaptureBuffer(10);
  buf.push({
    requestId: 'AAAA.1', method: 'GET', url: '/api/x', status: 200, reqMime: null,
    resMime: 'application/json', hasPostData: false, startTime: Date.now(), endTime: Date.now() + 10,
    durationMs: 10, size: 1024, fromCache: false, errorText: null, frame: 'top',
    frameSessionId: 'S1', state: 'done',
  });
  const out = netcaptureListStr(buf);
  assert.match(out, /1 request captured/);
  assert.match(out, /GET/);
  assert.match(out, /200/);
  assert.match(out, /\/api\/x/);
});

test('netcaptureListStr Q-flag marks requests with bodies', () => {
  const buf = new NetcaptureBuffer(10);
  buf.push({
    requestId: 'AAAA.1', method: 'POST', url: '/api/x', status: 200,
    reqMime: 'application/json', resMime: 'application/json', hasPostData: true,
    startTime: Date.now(), endTime: Date.now() + 5, durationMs: 5, size: 100,
    fromCache: false, errorText: null, frame: 'top', frameSessionId: 'S1', state: 'done',
  });
  const out = netcaptureListStr(buf);
  assert.match(out, /POST Q/);
});

test('netcaptureListStr --status filters work', () => {
  const buf = new NetcaptureBuffer(10);
  buf.push({
    requestId: 'A.1', method: 'GET', url: '/ok', status: 200, hasPostData: false,
    startTime: Date.now(), durationMs: 1, size: 10, state: 'done', frame: 'top',
  });
  buf.push({
    requestId: 'A.2', method: 'GET', url: '/bad', status: 422, hasPostData: false,
    startTime: Date.now(), durationMs: 1, size: 10, state: 'done', frame: 'top',
  });
  const out = netcaptureListStr(buf, { status: '4xx' });
  assert.match(out, /\/bad/);
  assert.doesNotMatch(out, /\/ok/);
});

test('netcaptureListStr --url-contains narrows by substring', () => {
  const buf = new NetcaptureBuffer(10);
  buf.push({ requestId: 'A.1', method: 'GET', url: '/api/x', status: 200, hasPostData: false, startTime: Date.now(), state: 'done', frame: 'top' });
  buf.push({ requestId: 'A.2', method: 'GET', url: '/static/y.png', status: 200, hasPostData: false, startTime: Date.now(), state: 'done', frame: 'top' });
  const out = netcaptureListStr(buf, { 'url-contains': '/api/' });
  assert.match(out, /\/api\/x/);
  assert.doesNotMatch(out, /\/static\//);
});
