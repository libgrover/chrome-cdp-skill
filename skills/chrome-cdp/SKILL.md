---
name: chrome-cdp
description: Read live Chrome — open tabs, screenshots (viewport or full page), accessibility tree, DOM, JS eval, buffered console messages (errors, warnings, logs), buffered network requests with request and response bodies, localStorage/sessionStorage/cookies/IndexedDB, click/type/navigate, wait-for-selector. Requires explicit user approval before first use per session.
---

# Chrome CDP

Lightweight Chrome DevTools Protocol CLI. Connects directly via WebSocket — no Puppeteer, works with 100+ tabs, instant connection.

## Prerequisites

- Chrome (or Chromium, Brave, Edge, Vivaldi) with remote debugging enabled: open `chrome://inspect/#remote-debugging` and toggle the switch
- Node.js 22+ (uses built-in WebSocket)
- If your browser's `DevToolsActivePort` is in a non-standard location, set `CDP_PORT_FILE` to its full path

## Commands

All commands use `scripts/cdp.mjs`. The `<target>` is a **unique** targetId prefix from `list`; copy the full prefix shown in the `list` output (for example `6BE827FA`). The CLI rejects ambiguous prefixes.

### List open pages

```bash
scripts/cdp.mjs list
```

### Take a screenshot

```bash
scripts/cdp.mjs shot <target> [file]    # default: screenshot-<target>.png in runtime dir
scripts/cdp.mjs shot <target> --full    # entire scrollable page (saved as screenshot-<target>-full.png)
```

Without `--full`, captures the **viewport only** — scroll first with `eval` if you need content below the fold. With `--full`, captures the full scrollable page. Output includes the page's DPR and coordinate conversion hint (see **Coordinates** below).

### Accessibility tree snapshot

```bash
scripts/cdp.mjs snap <target>
```

### Evaluate JavaScript

```bash
scripts/cdp.mjs eval <target> <expr>
```

> **Watch out:** avoid index-based selection (`querySelectorAll(...)[i]`) across multiple `eval` calls when the DOM can change between them (e.g. after clicking Ignore, card indices shift). Collect all data in one `eval` or use stable selectors.

### Console messages

Buffered (last 1,000) console calls, uncaught exceptions, and browser log entries (CSP violations, deprecation warnings, security errors). Capture begins as soon as the daemon attaches — see **Capture timing** below.

```bash
scripts/cdp.mjs console <target>                              # summary + last 50
scripts/cdp.mjs console <target> --last 200                   # last 200 records
scripts/cdp.mjs console <target> --all                        # everything in the buffer
scripts/cdp.mjs console <target> --since 5m                   # only the last 5 minutes
scripts/cdp.mjs console <target> --level error,warn           # comma list: error, warn, info, log, debug
scripts/cdp.mjs console <target> --frame oopif                # only iframe entries; --frame top for main only
scripts/cdp.mjs console <target> --json                       # machine-readable
scripts/cdp.mjs console <target> clear                        # reset the buffer
```

The buffer is **read-only**. Repeated reads return the same content (no implicit drain). Use `clear` only when you want a fresh window.

### Network capture

Buffered (last 500) HTTP requests with status, MIME, timing, and on-demand request/response body fetch. Captures cross-origin iframes too. Capture begins when the daemon attaches — see **Capture timing**.

```bash
scripts/cdp.mjs netcapture <target>                                # summary + last 50
scripts/cdp.mjs netcapture <target> --last 200                     # last 200
scripts/cdp.mjs netcapture <target> --all                          # everything
scripts/cdp.mjs netcapture <target> --since 5m                     # last 5 minutes
scripts/cdp.mjs netcapture <target> --status 4xx,5xx,404           # families or codes
scripts/cdp.mjs netcapture <target> --method POST,PUT,DELETE       # comma list
scripts/cdp.mjs netcapture <target> --mime json                    # substring on response MIME
scripts/cdp.mjs netcapture <target> --url-contains /api/           # URL substring
scripts/cdp.mjs netcapture <target> --url-regex '^https://api\.'   # URL regex
scripts/cdp.mjs netcapture <target> --frame oopif                  # only iframe-origin requests
scripts/cdp.mjs netcapture <target> --json
scripts/cdp.mjs netcapture <target> clear
```

Each row leads with a short `REQ_ID` (e.g. `A3F1-7C`). A trailing `Q` flag on the METHOD column marks rows that carry a request body — so `grep "POST.*Q"` lands on payload-bearing rows immediately.

Fetch a body:

```bash
scripts/cdp.mjs netcapture <target> body    <reqId> [--head N] [--save <path>]    # response body
scripts/cdp.mjs netcapture <target> reqbody <reqId> [--head N] [--save <path>]    # request body
```

Text MIMEs (`text/*`, `application/json`, `application/xml`, `application/javascript`, `application/*+json`) print inline. Binary or unknown MIME types refuse the inline path — pass `--head <bytes>` for a hex peek or `--save <path>` to write to disk. The 5 MB ceiling applies to inline fetches in either direction; pass `--head` or `--save` for larger bodies.

### Storage

One-shot read of `localStorage`, `sessionStorage`, cookies, and IndexedDB database names for the top-frame origin.

```bash
scripts/cdp.mjs storage <target>                              # all four sections
scripts/cdp.mjs storage <target> --only local,session         # narrow with --only
scripts/cdp.mjs storage <target> --only cookies
scripts/cdp.mjs storage <target> --json
```

IndexedDB returns the **list of database names** only — per-DB record dumps are out of scope (IDB payloads can be huge; use `eval` if you need them).

### Wait for / wait gone

Block until a selector matches (or doesn't). Polls in-page at 100 ms. Exits non-zero on timeout.

```bash
scripts/cdp.mjs waitfor  <target> ".toast.success"
scripts/cdp.mjs waitfor  <target> "#patient-detail" --timeout 30s
scripts/cdp.mjs waitfor  <target> ".loaded" --visible           # requires offsetParent !== null
scripts/cdp.mjs waitgone <target> ".loading-spinner" --timeout 10s
```

### Other commands

```bash
scripts/cdp.mjs html    <target> [selector]   # full page or element HTML
scripts/cdp.mjs nav     <target> <url>         # navigate and wait for load
scripts/cdp.mjs net     <target>               # page-side resource timing (performance.getEntriesByType)
scripts/cdp.mjs click   <target> <selector>    # click element by CSS selector
scripts/cdp.mjs clickxy <target> <x> <y>       # click at CSS pixel coords
scripts/cdp.mjs type    <target> <text>         # Input.insertText at current focus; works in cross-origin iframes unlike eval
scripts/cdp.mjs loadall <target> <selector> [ms]  # click "load more" until gone (default 1500ms between clicks)
scripts/cdp.mjs evalraw <target> <method> [json]  # raw CDP command passthrough
scripts/cdp.mjs open    [url]                  # open new tab (each triggers Allow prompt)
scripts/cdp.mjs stop    [target]               # stop daemon(s)
```

### `net` vs `netcapture`

Two different lenses — pick the right one:

- **`net <target>`** — page-side snapshot from `performance.getEntriesByType('resource')`. Lightweight, instant, but only sees what the page itself can see: completed fetches with timing. No response bodies. No requests blocked before they hit the page.
- **`netcapture <target>`** — full CDP `Network`-domain capture. In-flight visibility, request and response bodies on demand, cross-origin iframes covered. Requires the daemon to have been active **when the request fired** (see Capture timing).

### Capture timing

The daemon for a tab spawns on the first `console`/`netcapture` call against it. Events fired before that call are not in the buffer.

To capture a page-load round trip end-to-end: run `console <target>` (or `netcapture <target>`) once **before** the action you want to observe (or before reloading the page). The first call attaches the daemon; subsequent calls read from a buffer that started filling at attach time.

### Cleanup when done

When you finish debugging a tab, run `scripts/cdp.mjs stop <target>` to release that tab's daemon. `stop` with no argument terminates every daemon this CLI has spawned. Each daemon holds an open CDP WebSocket plus the per-tab ring buffers; leaving them running between tasks isn't catastrophic — they auto-exit after 20 minutes of inactivity — but explicitly stopping them frees the resources immediately and avoids leftover "this tab is being debugged" state if Chrome surfaces it elsewhere.

## Coordinates

`shot` saves an image at native resolution: image pixels = CSS pixels × DPR. CDP Input events (`clickxy` etc.) take **CSS pixels**.

```
CSS px = screenshot image px / DPR
```

`shot` prints the DPR for the current page. Typical Retina (DPR=2): divide screenshot coords by 2.

## Tips

- Prefer `snap --compact` over `html` for page structure.
- Use `type` (not eval) to enter text in cross-origin iframes — `click`/`clickxy` to focus first, then `type`.
- Chrome shows an "Allow debugging" modal once per tab on first access. A background daemon keeps the session alive so subsequent commands need no further approval. Daemons auto-exit after 20 minutes of inactivity.
