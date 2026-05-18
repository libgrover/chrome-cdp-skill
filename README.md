# chrome-cdp

Let your AI agent see and interact with your **live Chrome session** — the tabs you already have open, your logged-in accounts, your current page state. No browser automation framework, no separate browser instance, no re-login.

Works out of the box with any Chrome installation. One toggle to enable, nothing else to install.

## Why this matters

Most browser automation tools launch a fresh, isolated browser. This one connects to the Chrome you're already running, so your agent can:

- Read pages you're logged into (Gmail, GitHub, internal tools, ...)
- Interact with tabs you're actively working in
- See the actual state of a page mid-workflow, not a clean reload

## Installation

### As a pi skill

```bash
pi install git:github.com/pasky/chrome-cdp-skill@v1.0.1
```

### For other agents (Amp, Claude Code, Cursor, etc.)

Clone or copy the `skills/chrome-cdp/` directory wherever your agent loads skills or context from. The only runtime dependency is **Node.js 22+** — no npm install needed.

### Enable remote debugging in Chrome

Navigate to `chrome://inspect/#remote-debugging` and toggle the switch. That's it.

The CLI auto-detects Chrome, Chromium, Brave, Edge, and Vivaldi on macOS, Linux, and Windows. If your browser stores `DevToolsActivePort` in a non-standard location, set the `CDP_PORT_FILE` environment variable to the full path.

## Usage

### Page inspection

```bash
scripts/cdp.mjs list                              # list open tabs
scripts/cdp.mjs shot   <target> [file] [--full]   # screenshot (viewport, or --full for entire scrollable page)
scripts/cdp.mjs snap   <target>                   # accessibility tree (compact, semantic)
scripts/cdp.mjs html   <target> [".selector"]     # full HTML or scoped to CSS selector
scripts/cdp.mjs eval   <target> "expression"      # evaluate JS in page context
```

### Buffered capture (console + network)

```bash
scripts/cdp.mjs console <target> [flags]          # buffered console / exception / log entries
scripts/cdp.mjs console <target> clear            # reset the console buffer

scripts/cdp.mjs netcapture <target> [flags]       # buffered HTTP request/response history
scripts/cdp.mjs netcapture <target> body    <reqId> [--head N] [--save <path>]  # fetch response body
scripts/cdp.mjs netcapture <target> reqbody <reqId> [--head N] [--save <path>]  # fetch request body
scripts/cdp.mjs netcapture <target> clear         # reset the netcapture buffer
```

Both buffers fill in real time once a tab's daemon is attached (first contact spawns it). Shared flags: `--last N`, `--all`, `--since <iso|5m|1h>`, `--json`. Per-command filters: `console --level error,warn`, `netcapture --status 4xx,5xx --method POST --mime json --url-contains "/api/" --url-regex "^https://api\\."`. Both honor `--frame top|oopif|<url>` since the daemon auto-attaches to cross-origin iframes. `netcapture` rows that carry a request body are marked with a `Q` flag in the METHOD column.

### Frontend helpers

```bash
scripts/cdp.mjs storage <target> [--only local,session,cookies,indexeddb] [--json]
                                                  # localStorage / sessionStorage / cookies / IndexedDB names

scripts/cdp.mjs waitfor  <target> "selector" [--timeout 10s] [--visible]
                                                  # block until selector matches (and is visible)
scripts/cdp.mjs waitgone <target> "selector" [--timeout 10s]
                                                  # block until selector clears
```

### Interaction

```bash
scripts/cdp.mjs nav    <target> https://...       # navigate and wait for load
scripts/cdp.mjs click  <target> "selector"        # click element by CSS selector
scripts/cdp.mjs clickxy <target> <x> <y>          # click at CSS pixel coordinates
scripts/cdp.mjs type   <target> "text"            # type at focused element (works in cross-origin iframes)
scripts/cdp.mjs loadall <target> "selector"       # click "load more" until gone
```

### Miscellaneous

```bash
scripts/cdp.mjs net     <target>                  # lightweight page-side resource timing (page's own performance API)
scripts/cdp.mjs evalraw <target> <method> [json]  # raw CDP command passthrough
scripts/cdp.mjs open    [url]                     # open new tab (triggers Allow prompt)
scripts/cdp.mjs stop    [target]                  # stop daemon(s); run this when done debugging
```

`<target>` is a unique prefix of the targetId shown by `list`. `<reqId>` for `netcapture body`/`reqbody` is the short prefix shown in the REQ_ID column of `netcapture`.

**`net` vs `netcapture`:** `net` is a one-shot read of the page's own `performance.getEntriesByType('resource')` — lightweight, instant, but only covers what the page can see (no in-flight, no bodies). `netcapture` is the full CDP `Network`-domain capture with request and response bodies on demand, and requires the daemon to have been active when the request fired.

## Why not chrome-devtools-mcp?

[chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) reconnects on every command, so Chrome's "Allow debugging" modal can re-appear repeatedly and target enumeration times out with many tabs open. `chrome-cdp` holds one persistent daemon per tab — the modal fires once, and it handles 100+ tabs reliably.

## How it works

Connects directly to Chrome's remote debugging WebSocket — no Puppeteer, no intermediary. On first access to a tab, a lightweight background daemon is spawned that holds the session open. Chrome's "Allow debugging" modal appears once per tab; subsequent commands reuse the daemon silently. Daemons auto-exit after 20 minutes of inactivity.

This approach is also why it handles 100+ open tabs reliably, where tools built on Puppeteer often time out during target enumeration.
