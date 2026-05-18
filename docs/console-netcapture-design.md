# `console` + `netcapture` — Design (v2, post-review)

Extending `chrome-cdp-skill` to give Claude DevTools-level visibility into a live tab: console messages, uncaught exceptions, browser log entries, and full HTTP request/response capture including bodies. Adds two CLI commands to `scripts/cdp.mjs` and per-tab daemon machinery to back them.

This revision incorporates a senior-review pass. Key changes from v1:

- **Never drain implicitly.** Buffers rotate, agent windows with `--since` / `--last`.
- **Summary-first output.** Default response shows aggregate counts + last 50 rows. The 1000- and 500-cap totals are reachable on demand, not dumped by default.
- **Binary-body safety.** `netcapture body` refuses non-text MIME types unless the caller passes `--save <path>` or `--head <bytes>`.
- **Cross-origin iframes.** OOPIF auto-attach so marketplace-style iframe console messages aren't silently dropped.
- **Reset on navigation.** Buffers reset on top-frame navigation with a synthetic boundary record so the snapshot stays page-scoped.
- **Warming stays lazy.** The first `console`/`netcapture` call against a tab spawns its daemon. Documented in SKILL.md so the agent knows to make that call *before* the action it wants to observe — no `--warm-all`, no explicit `warm` command, no modal storm.
- **`--json` from day one.** Both commands honor `--json` for machine-readable output.
- **SKILL.md description rewritten** so agents can actually discover the new capabilities without loading the body.

## Goals

1. **`console <target>`** — surface every `console.*` call, uncaught exception, and browser-level log entry (CSP violations, mixed-content blocks, deprecation warnings, security errors) in the target tab.
2. **`netcapture <target>`** — list every HTTP request the page made, with URL, method, status, timing, and content-type. Fetch the full response body on demand.

Both commands are non-destructive. Both surface ring-buffered state held by the daemon. Neither modifies page state.

## Non-goals

- WebSocket / SSE / WebTransport message capture. CDP exposes these via separate events (`Network.webSocketFrameReceived` etc.) — out of scope for v1.
- Persistent storage. The daemon already auto-exits after 20 minutes idle; buffers die with it. Capture is for live debugging, not audit logging.
- `Profiler` / `Tracing` domain integration. Different problem, different command.
- `--follow` streaming. Snapshot semantics are functionally equivalent for an act-then-observe agent loop, and `--follow` would require an invasive change to the CLI↔daemon NDJSON protocol. Revisit in v2 only if a concrete use case shows up.

## Current architecture — relevant parts

From reading `scripts/cdp.mjs`:

- One daemon process per tab, spawned by the CLI on first contact. Listens on a Unix socket at `${runtimeDir}/<targetId>.sock`.
- Daemon holds one CDP WebSocket connection (`new CDP()`) plus one attached session (`Target.attachToTarget` → `sessionId`).
- Each CLI invocation opens the socket, writes one NDJSON `{ id, cmd, args }` line, reads one response line, exits. Daemon stays running.
- Daemon currently subscribes to no events other than lifecycle (`Target.targetDestroyed`, `Target.detachedFromTarget`) and connection-close.

Event-driven state must therefore be added at daemon startup. The daemon enables `Runtime`, `Log`, `Network` domains once and installs `cdp.onEvent(...)` listeners that push into in-memory ring buffers held in daemon-process closure scope.

## Decisions

| Question | Decision | Why |
|---|---|---|
| Enable Runtime/Log/Network at daemon startup, or lazily on first `console`/`netcapture`? | **Eager (startup)** | Bug repros usually involve early-page-life messages. Listener overhead is negligible compared to the buffer itself. |
| Buffer caps | **1000 console messages, 500 network requests** | Sized so the daemon RSS stays manageable. Add a per-record byte ceiling (below) so a single huge object can't blow this up. |
| Per-record byte ceiling | **8 KB per console message, 4 KB per network record summary** | Truncate at write time. Surface `(truncated, +N bytes elided)` suffix on truncated records. Bodies are *not* part of this — they're fetched separately. |
| Drain on read? | **Never.** Ring buffer rotates naturally. `console clear` and `netcapture clear` are explicit commands. | Implicit drain is hostile to agents — a truncated output or retry loses data, and the agent has no way to know. |
| Default output size | **Summary header + last 50 rows.** `--all`, `--last N`, and filters widen / narrow. | 500 rows is several thousand tokens. Default has to be small or agents will burn context on every call. |
| Body fetch for binary MIME | **Refuse unless `--save <path>` or `--head <bytes>` is passed.** | A 2MB PDF base64-decoded blows the context window. The text path (`text/*`, `application/json`, `application/xml`) prints inline; everything else takes the safe path. |
| Cross-origin iframe console events | **Auto-attach to OOPIFs via `Target.setAutoAttach { autoAttach: true, flatten: true }`.** Enable Runtime/Log/Network on each new attached session. | Marketplace apps run in iframes in this org's host EHR — without OOPIF capture, the new commands miss the most interesting debug surface. |
| Buffer reset on navigation | **Reset on top-frame `Page.frameNavigated`.** Insert a synthetic boundary record at the buffer head: `--- navigation to <url> (buffer reset) ---`. | Without reset, requests from a previous page interleave with the current page's history. The boundary record keeps the snapshot self-describing. |
| Missed-events window before daemon attaches | **Lazy attach stays as-is.** The first `console`/`netcapture` call against a tab spawns its daemon. Document the workflow in SKILL.md: agents must call `console <target>` (or `netcapture <target>`) **before** the action they want to observe to guarantee full capture. | The user observed we'll only ever monitor a few tabs at once — a `--warm-all` flag or auto-warm-on-`list` solves a problem that doesn't exist, and would trigger one "Allow debugging" modal per untouched tab on first use. |
| Filters | **Day one. Both commands.** | "Show me the failing requests" is a much smaller payload than "show me 500 requests, agent, please grep." Filters live next to the command in the daemon so the wire payload is already narrow. |
| Filter overflow / dropped-record visibility | **Lead with `(N earlier messages dropped — buffer cap 1000)` line when truncation has occurred.** Always emit, never suppress. | Agents need to know when the floor moved. |
| Output format | **Plain text by default, `--json` flag emits JSON.** | Match the existing CLI's text output. JSON is the escape hatch for brittle parsing. |

## SKILL.md description rewrite

Current description (always loaded by the agent before invoking the skill):

> Interact with local Chrome browser session (only on explicit user approval after being asked to inspect, debug, or interact with a page open in Chrome)

Replace with:

> Read live Chrome — open tabs, screenshots, accessibility tree, DOM, JS eval, console messages (errors, warnings, logs), network requests with response bodies, click/type/navigate. Requires explicit user approval before first use per session.

38 words, names the capabilities the agent will reach for. Without this, no agent will pull the skill up when the user says "check the network tab for failing requests."

## `console` command

### CDP setup (per attached session)

```
Runtime.enable
Log.enable
```

Applied to the top-frame session at daemon startup and to every OOPIF session as it auto-attaches.

### Events captured

| Event | Coverage |
|---|---|
| `Runtime.consoleAPICalled` | `console.log/info/warn/error/debug/trace/assert/...` |
| `Runtime.exceptionThrown` | Uncaught JS, unhandled promise rejections |
| `Log.entryAdded` | CSP violations, deprecation warnings, security errors, mixed content, browser-emitted network failures |

### Buffer record shape

```js
{
  ts: 1734567890123,                  // ms since epoch
  source: 'console' | 'exception' | 'log',
  level: 'log' | 'info' | 'warn' | 'error' | 'debug',
  text: string,                       // human-rendered; truncated to 8KB with "…(truncated, +N bytes elided)" suffix
  frame: 'top' | string,              // 'top' for main frame, OOPIF URL otherwise
  stack: string | null,               // present for exceptions and console.trace
  origin: string | null,              // location URL of the call site if known
}
```

`Runtime.consoleAPICalled.args[]` are CDP `RemoteObject` values. Render with a `formatRemoteObject(arg)` helper:

- Primitives: print `value`.
- Errors: print `description` (CDP fills this with the stack-trace string).
- Other objects: print `description` if present, else `[object <className>]`.
- Strings concatenated with spaces, DevTools-style.

Not aiming for byte-perfect DevTools parity. The agent reads text; legibility matters more than fidelity.

### CLI surface

```bash
scripts/cdp.mjs console <target>                              # summary + last 50
scripts/cdp.mjs console <target> --last 200                   # last 200
scripts/cdp.mjs console <target> --all                        # entire buffer
scripts/cdp.mjs console <target> --since 2025-12-01T18:00:00Z # filter by time
scripts/cdp.mjs console <target> --since 5m                   # relative time
scripts/cdp.mjs console <target> --level error,warn           # level filter (comma list)
scripts/cdp.mjs console <target> --frame oopif                # only iframe entries
scripts/cdp.mjs console <target> --json                       # machine-readable
scripts/cdp.mjs console <target> clear                        # reset the buffer
```

`--since` accepts ISO 8601 or relative durations (`5m`, `1h`, `30s`).

### Default output

```
1,217 messages buffered (1,142 log · 67 warn · 8 error). Showing last 50.

[12:34:56.123] error  ReferenceError: foo is not defined
                      at Object.<anonymous> (https://localhost:3000/app.js:42:10)
[12:34:56.124] warn   Mixed content: page at … loaded over HTTPS
[12:34:56.130] log    [HMR] connected
...
```

If the ring dropped messages since the last read, line 1 is replaced with:

```
1,000 messages buffered (cap 1,000) · 127 earlier messages dropped · 0 since "<filter>". Showing last 50.
```

## `netcapture` command

### CDP setup (per attached session)

```
Network.enable
```

Applied to top-frame session at daemon startup and to OOPIFs as they auto-attach.

### Events captured

| Event | What we record |
|---|---|
| `Network.requestWillBeSent` | requestId, URL, method, time, frame, request headers, `hasPostData`, request body MIME (from `Content-Type` header) |
| `Network.requestWillBeSentExtraInfo` | merged into the same record to pick up the final outgoing headers after CORS/preflight handling |
| `Network.responseReceived` | status, response MIME, response headers, fromCache, encodedDataLength |
| `Network.loadingFinished` | final size, completion time → mark `done` |
| `Network.loadingFailed` | errorText → mark `failed` |

Request bodies (POST payloads etc.) are *not* eagerly captured. The summary record carries `hasPostData: boolean` so the agent can tell from the list which requests have a body to fetch. The body itself is fetched on demand via `Network.getRequestPostData({ requestId })`, mirroring how response bodies work — same MIME-aware refusal rules, same 5MB ceiling.

### Buffer record shape

```js
{
  requestId: string,
  method: string,
  url: string,                        // truncated to 4KB
  status: number | null,
  reqMime: string | null,             // request Content-Type, if set
  resMime: string | null,             // response Content-Type
  hasPostData: boolean,               // true when a request body was sent
  startTime: number,                  // ms since epoch
  endTime: number | null,
  durationMs: number | null,
  size: number | null,                // response bytes (encodedDataLength)
  fromCache: boolean,
  errorText: string | null,
  frame: 'top' | string,
  state: 'pending' | 'done' | 'failed',
}
```

Bodies (request and response) are *not* stored. Chrome retains them per-session and we fetch on demand via `Network.getRequestPostData` and `Network.getResponseBody`.

### CLI surface

```bash
scripts/cdp.mjs netcapture <target>                            # summary + last 50
scripts/cdp.mjs netcapture <target> --last 200
scripts/cdp.mjs netcapture <target> --all
scripts/cdp.mjs netcapture <target> --since 5m
scripts/cdp.mjs netcapture <target> --method POST,PUT,DELETE
scripts/cdp.mjs netcapture <target> --status 4xx,5xx           # families or specific codes (404, 500)
scripts/cdp.mjs netcapture <target> --mime json                # substring on MIME type
scripts/cdp.mjs netcapture <target> --url-contains /api/
scripts/cdp.mjs netcapture <target> --url-regex '^https://api\.'
scripts/cdp.mjs netcapture <target> --frame oopif
scripts/cdp.mjs netcapture <target> --json
scripts/cdp.mjs netcapture <target> body <requestId>           # fetch response body
scripts/cdp.mjs netcapture <target> body <requestId> --head 4096
scripts/cdp.mjs netcapture <target> body <requestId> --save /tmp/out.bin
scripts/cdp.mjs netcapture <target> reqbody <requestId>        # fetch request body (POST payload)
scripts/cdp.mjs netcapture <target> reqbody <requestId> --head 4096
scripts/cdp.mjs netcapture <target> reqbody <requestId> --save /tmp/req.bin
scripts/cdp.mjs netcapture <target> clear
```

Filter syntax notes:

- `--status` accepts `Nxx` family shorthand (`4xx` means 400–499) or specific codes, comma-separated.
- `--method` is exact match, comma-separated.
- `--mime` is substring match (`json` matches `application/json`, `application/vnd.api+json`).
- `--url-contains` and `--url-regex` compose with each other and with all other filters via AND.

### Default output (list view)

A trailing `Q` flag in the METHOD column marks requests that carry a payload — agents looking for "the failed POST with the wrong body" can grep for `POST.*Q` and the right row jumps out.

```
547 requests captured (412 GET · 89 POST · 46 OTHER · 12 failed · 89 4xx · 23 5xx). Showing last 50.

REQ_ID    TIME       METHOD   STATUS  DURATION  SIZE   MIME              URL
A3F1-7B   12:34:56   GET      200     45ms      4.2KB  application/json   https://api.orion.local/v1/patients?…
A3F1-7C   12:34:57   POST Q   422     12ms      1.1KB  application/json   https://api.orion.local/v1/encounters
A3F1-7D   12:34:58   GET      —       (pending) —      —                  https://api.orion.local/v1/sse-stream
A3F1-7E   12:34:59   GET      500     200ms     —      —                  https://cdn.example.com/missing.js   [failed: net::ERR_…]
```

`REQ_ID` is a short prefix of the CDP `requestId` (first 8 chars after stripping the session prefix). Like `<target>`, agents pass any unique prefix to `body`/`reqbody`. The leading column makes IDs greppable without hunting.

### `netcapture body <requestId>` and `netcapture reqbody <requestId>`

Both follow the same flow, only the CDP call differs (`Network.getResponseBody` vs `Network.getRequestPostData`) and the MIME source differs (response `Content-Type` vs request `Content-Type`).

1. Resolve the prefix to a full requestId. Error on ambiguous prefix.
2. Look up the record. If unknown: `Unknown requestId 'XYZ'. Run \`netcapture <target>\` to see active IDs.`
3. For `reqbody`: if `hasPostData` is false, error: `Request 'XYZ' had no body (method=GET, hasPostData=false).`
4. Determine MIME type (response or request, depending on subcommand).
5. Decide handling:
   - Text MIME (`text/*`, `application/json`, `application/xml`, `application/javascript`, `application/x-www-form-urlencoded`) → print inline (truncated to `--head` if passed, else full body).
   - Binary MIME or unknown → refuse unless `--head` or `--save` was passed. Error: `Body is binary (image/png, 1.2MB). Pass --head <bytes> to peek or --save <path> to write to disk.`
6. Call the appropriate CDP method. If Chrome returns "No data found" / "No resource with given identifier": `Body no longer available — Chrome may have evicted it. Reload the page to recapture.`
7. If `base64Encoded`, decode before any further handling.
8. Enforce the 5 MB ceiling before printing — if the decoded body exceeds 5 MB and no `--head` / `--save` was passed, refuse with the same hint pattern as binary MIME. This protects against a 50 MB JSON dump blocking the CDP WebSocket while Chrome serializes.
9. Apply `--head` (text or binary) or `--save` (always allowed).

## Frontend helpers — `storage`, `waitfor`, `waitgone`, `shot --full`

Three small additions that round out the frontend-debug surface without standing up new ring buffers or event streams. All one-shot reads / synchronous interactions.

### `storage <target>`

Read browser storage. Each section is opt-out via flags so the agent can narrow the output when only one kind matters.

```bash
scripts/cdp.mjs storage <target>                              # all sections
scripts/cdp.mjs storage <target> --only local,session         # comma list
scripts/cdp.mjs storage <target> --only cookies
scripts/cdp.mjs storage <target> --json
```

Sections covered:

| Section | CDP source |
|---|---|
| `local` | `DOMStorage.getDOMStorageItems` with `isLocalStorage: true` (top-frame origin) |
| `session` | `DOMStorage.getDOMStorageItems` with `isLocalStorage: false` |
| `cookies` | `Network.getCookies` (no filter — returns the tab's full jar) |
| `indexeddb` | `IndexedDB.requestDatabaseNames` → list only. Per-DB record dumps are out of scope; IDB payloads can be huge. |

Default output is sectioned text:

```
=== localStorage (https://localhost:3000) ===
auth.token = eyJhbGc...
auth.refreshToken = (8.2 KB, truncated)
ui.theme = "dark"

=== sessionStorage ===
(empty)

=== cookies (3) ===
session_id    .orion.local   /   HttpOnly  Secure  expires=2026-06-01T00:00:00Z
csrf_token    localhost      /   Secure
XSRF-TOKEN    localhost      /

=== IndexedDB ===
keyval-store, idb-cache
```

Same 4 KB per-record cap as netcapture rows.

### `waitfor <target> "selector" [--timeout 10s] [--visible]`

Block until the selector matches at least one element. `--visible` requires `offsetParent !== null` (a cheap-and-correct enough proxy for visibility). Exits 0 on match, non-zero on timeout. Implemented via `Runtime.evaluate` polling at 100ms intervals inside the page context — no event-driven CDP plumbing needed. Same default timeout shape as `nav`.

```bash
scripts/cdp.mjs waitfor <target> ".toast.success"
scripts/cdp.mjs waitfor <target> "#patient-detail" --timeout 30s
scripts/cdp.mjs waitfor <target> ".loaded" --visible
```

### `waitgone <target> "selector" [--timeout 10s]`

Inverse of `waitfor` — block until the selector matches *zero* elements. For dismissing toasts, waiting for loading spinners to clear, etc.

### `shot <target> --full`

One flag added to the existing `shot` command. Passes `captureBeyondViewport: true` to `Page.captureScreenshot`. Output filename is suffixed `-full` when the flag is present so the agent can keep both viewport and full-page shots side by side.

```bash
scripts/cdp.mjs shot <target>                  # viewport only (existing behavior)
scripts/cdp.mjs shot <target> --full           # entire scrollable page
scripts/cdp.mjs shot <target> screenshot.png   # explicit file (still viewport)
scripts/cdp.mjs shot <target> --full screenshot-full.png
```

## `net` vs `netcapture` disambiguation

The existing `net` command surfaces the page's own Performance API resource-timing entries. It's a snapshot of what the page itself can see, and only covers fetches that completed. Keep it. Add a one-liner under each command in SKILL.md:

- `net <target>` — lightweight snapshot from the page's `performance.getEntriesByType('resource')` API. Doesn't see in-flight requests, doesn't see response bodies, doesn't see requests blocked before the page was reached.
- `netcapture <target>` — full CDP `Network`-domain capture; in-flight visibility, request *and* response bodies on demand, requires the daemon to have been active when the request fired.

## Implementation plan

Five edits to `scripts/cdp.mjs`, one to `SKILL.md`, plus a new `tests/` directory. Estimated diff size ~450 lines added.

### File diff sketch

1. **`scripts/cdp.mjs` — constants** *(+8 lines)*
   ```
   const CONSOLE_BUFFER_CAP = 1000;
   const NETCAPTURE_BUFFER_CAP = 500;
   const CONSOLE_RECORD_MAX_BYTES = 8 * 1024;
   const NETCAPTURE_RECORD_MAX_BYTES = 4 * 1024;
   const DEFAULT_LAST_N = 50;
   const TEXT_MIME_PATTERNS = [/^text\//, /^application\/json/, /^application\/xml/, /^application\/javascript/, /^application\/x-www-form-urlencoded/];
   ```

2. **`scripts/cdp.mjs` — helpers** *(+90 lines)*
   - `formatRemoteObject(arg)` — primitive / Error / object rendering.
   - `truncate(s, max)` — returns `{ value, truncated, originalLength }`.
   - `parseSince(input)` → returns `tsMs`; accepts ISO 8601 + relative.
   - `parseStatusFilter(input)` → list of predicates.
   - `parseMethodFilter`, `parseMimeFilter`, `parseUrlFilter` — same shape.
   - `compactRequestId(fullId)` → first 8 chars after any session prefix.
   - `summary(buf, kind)` → header line.

3. **`scripts/cdp.mjs` — ring buffer module** *(+60 lines)*
   - One class shared by both buffers — push with cap, snapshot, clear, dropped-count tracking.
   - `NetcaptureBuffer` extends with an internal `Map<requestId, indexInRing>` so `responseReceived` / `loadingFinished` / `loadingFailed` updates are O(1).
   - Both buffers hold an internal `lastResetTs` updated on `Page.frameNavigated`.

4. **`scripts/cdp.mjs` — `runDaemon` startup additions** *(+120 lines)*
   - After `Target.attachToTarget`, call `Target.setAutoAttach { autoAttach: true, flatten: true, waitForDebuggerOnStart: false }`.
   - Enable `Runtime`, `Log`, `Network`, `Page` on the top session.
   - On `Target.attachedToTarget`, enable the same domains on the new session and remember the session→frame mapping.
   - On `Target.detachedFromTarget`, drop the mapping.
   - On `Page.frameNavigated` for the top frame: insert boundary record into both buffers, reset their dropped counters.
   - Wire event listeners: `Runtime.consoleAPICalled`, `Runtime.exceptionThrown`, `Log.entryAdded`, `Network.requestWillBeSent`, `Network.responseReceived`, `Network.loadingFinished`, `Network.loadingFailed`. Each filters on `params.sessionId` against the known-session set so we don't accidentally pick up events from other daemons sharing the same CDP connection (which we don't, but defensive).

5. **`scripts/cdp.mjs` — new formatter functions** *(+150 lines)*
   - `consoleStr(buf, opts)` → summary + filtered + last-N + text/JSON.
   - `netcaptureListStr(buf, opts)` → same shape, with the `Q` flag on POST-data-bearing rows.
   - `netcaptureBodyStr(cdp, sessionId, buf, requestIdPrefix, opts)` → resolve prefix, MIME-aware fetch, head/save handling, 5MB ceiling. Used by both `body` and `reqbody` (one shared helper with a `which: 'request' | 'response'` parameter).

6. **`scripts/cdp.mjs` — `handleCommand` switch** *(+25 lines)*
   - Add `case 'console':`, `case 'netcapture':` (with sub-verbs `body` / `reqbody` / `clear`).

7. **`SKILL.md`** *(+70 lines)*
   - Rewrite the description.
   - New `### Console messages` and `### Network capture` sections under Commands, documenting both `body` and `reqbody` subcommands.
   - Add the `net` vs `netcapture` disambiguator.
   - Document the lazy-attach workflow: call `console <target>` or `netcapture <target>` once *before* the action you want to observe, so the daemon is active when the request fires.

8. **`tests/buffer.test.mjs`** *(new, ~90 lines)*
   - Vitest harness or plain `node --test`. Feeds synthetic CDP events through the buffer module directly. Covers: push past cap drops oldest, dropped-count math, per-record byte ceiling truncation, navigation reset inserts boundary, filter predicates compose correctly, `hasPostData` propagates from `Network.requestWillBeSent` into the record.
   - No real Chrome needed — the buffer is a pure function of an event stream.

### Order of work

| Step | Scope | Estimate |
|---|---|---|
| 1 | Helpers, ring buffer, basic `console` happy path (no filters, no OOPIF, no navigation reset) | 1 evening |
| 2 | Filters, `--since`, `--last`, `--all`, `--json` on `console` | 1 evening |
| 3 | OOPIF auto-attach + navigation reset (applies to console; netcapture inherits this) | 1 evening |
| 4 | `netcapture` list view with all filters | 1 evening |
| 5 | `netcapture body` + `reqbody` with MIME-aware handling, `--save`, `--head`, 5MB ceiling | 1 evening |
| 6 | `storage`, `waitfor`/`waitgone`, `shot --full` | 1 evening |
| 7 | SKILL.md rewrite, vitest harness, polish | 1 evening |

About a week of evenings end to end. Honest version. The original "two evenings total" estimate was wrong.

## Test plan

### Buffer unit tests (`tests/buffer.test.mjs`)

Pure data tests — no Chrome required.

- Push 1100 records into a 1000-cap buffer. Snapshot should be 1000; dropped should be 100; record 0 should be the 101st pushed.
- Push 5 records, navigation-reset, push 3 more. Snapshot should be 8 records plus the boundary record; dropped should reset to 0.
- Push a 12KB console message. Snapshot record text should be 8KB with `(truncated, +4096 bytes elided)` suffix.
- Apply a `level: error` filter against a mixed buffer — output count should match the expected subset.
- Status family filter `4xx,500` matches 404, 422, 500 but not 200, 502.

### Manual smoke against a real page

1. Open `chrome://inspect`, attach. From the DevTools console: `console.log("hi"); console.warn("w"); throw new Error("boom")`.
2. `cdp.mjs console <target>` shows summary line + the three messages at distinct levels with stacks where applicable.
3. Repeat → still shows them (no implicit drain).
4. `cdp.mjs console clear <target>` then `console <target>` → empty.
5. Reload page → console should show the synthetic boundary record at the top, then a fresh capture.
6. Open an Orion-EHR app sandbox with a marketplace app loaded in an iframe; trigger a `console.error` inside the iframe; `console <target>` should include it with `frame` set to the iframe origin.
7. Open a page that makes XHRs. `cdp.mjs netcapture <target>` shows summary + last 50 with REQ_ID column.
8. `cdp.mjs netcapture <target> --status 4xx` on a page that 404s → only the 404 rows.
9. `cdp.mjs netcapture body <REQID>` on a JSON response → body prints inline.
10. `cdp.mjs netcapture body <REQID>` on an image response → refuses, surfaces the `--save` / `--head` hint.
11. `cdp.mjs netcapture body <REQID> --save /tmp/out.png` → file on disk, byte-identical to what DevTools would show.
12. Issue a POST from the page (e.g. via the DevTools console: `fetch('/v1/foo', { method: 'POST', body: '{"hello":"world"}', headers: {'Content-Type':'application/json'} })`). `cdp.mjs netcapture <target>` shows the row with a `Q` flag. `cdp.mjs netcapture reqbody <REQID>` prints the JSON body.
13. `cdp.mjs netcapture reqbody <REQID>` on a GET request → refuses with `Request 'XYZ' had no body (method=GET, hasPostData=false).`

## Open questions

None blocking implementation. Decisions made during review:

- Warming stays lazy — user observed monitoring is always scoped to a few tabs at a time, so the modal-storm cost of any auto-warm strategy isn't worth paying.
- Request bodies are in — `netcapture reqbody <id>` mirrors `body`, same MIME-aware safety rails. The agent needs full request/response visibility to debug end-to-end.
- 5 MB per-fetch ceiling — applies to both `body` and `reqbody`. Prevents blocking the CDP WebSocket while Chrome serializes huge payloads.

## Out of scope reminders

- This is a CLI skill, not an MCP server. Don't introduce dependencies that require `npm install` — pasky's whole pitch is "Node 22+ stdlib, no install."
- Don't break existing commands. The buffers and listeners are additive; existing one-shot commands stay identical.
- No JSON-by-default. The `--json` flag is opt-in; text remains the default for parity with the rest of the CLI.
