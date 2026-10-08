# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

Sends the current Chrome tab to a 1st-gen iPad (iOS 5.1.1, Safari 5.1) as clean, readable HTML.
There are three parts: a Chrome MV3 extension, a Node server (Hono), and a reader page that the iPad polls.

## Commands

```bash
npm install
npm test                                         # node:test, runs every test/*.test.js
node --test test/extract.test.js                 # one file
node --test --test-name-pattern="anchor" test/   # tests whose name matches
npm run lint                                     # ESLint, public/ only (ES5 check for the iPad)
npm start                                        # foreground server on :7777 (PORT, DATA_DIR env vars)
./serve                                          # git pull + npm install, then (re)start in tmux session "ipad-send"
tail -f log/server.log
```

Node ≥ 22 and `pandoc` (3.8+, on PATH or set `PANDOC`) are required.
Runtime data is in `data/` (`history.json`, `archive.jsonl`, `docs/<id>.html`, `images/` cache). Delete it to reset.
`./serve` pulls from the remote named `github`, not `origin`.

## Architecture

**The send flow** goes extension → `POST /api/send` → `extract()` → `History.push()` → the iPad wakes from its long-poll.

- `extension/background.js` runs `grabPage()` inside the tab with `chrome.scripting.executeScript`, so that function has to be self-contained. It returns `{url, title, html}`, the full `outerHTML`.
  Before serializing, it inserts numbered `span[data-ipad-send-anchor]` markers in front of the text that is visible in the window (0 = topmost). This lets the iPad open at the same reading position.
- `src/extract.js` does the following:
  - parses the page with JSDOM and strips unsafe or heavy elements
  - resolves lazy-loaded images and srcset
  - makes URLs absolute
  - runs Mozilla Readability on a clone of the document
  - falls back to the whole `<body>` (`raw: true`, shown as "raw page" on the iPad) when Readability finds less than 140 characters of text
  - sanitizes the result: drops `on*` attributes and unsafe links, routes every image through `/img`

  It also keeps the topmost anchor marker that survived extraction and turns it into `id="ipad-send-continue"`.
- Raw markdown files (Chrome's plain-text view of a `.md`) are sent as `{url, title, markdown, line}` instead of html, where `line` is the source line at the top of the window.
  Markdown files on GitHub blob pages are sent the same way. The source comes from the page's React payload (or `/raw/`), and `line` from matching the topmost visible rendered block's text against the source.
  `src/markdown.js` runs `pandoc -f gfm+sourcepos`, and `extractMarkdown()` puts the anchor before the first element on that line (from `data-pos`), unwraps pandoc's per-word spans, then applies the same sanitization.
- `src/history.js` is the single source of truth. It holds an ordered list of up to 50 documents and a `current` pointer, plus a `version` counter that increases on every change.
  The state is written atomically (tmp file + rename). Document HTML is stored separately in `data/docs/`.
  - A new send always becomes `current`.
  - Documents pushed out of the 50 are never deleted: their HTML stays in `data/docs/` and their metadata is appended to `data/archive.jsonl`.
  - `go(from, step)` only moves if the reader is still on `from`, so a double tap can't skip a document.
  - `waitForChange(since)` backs the `/api/wait` long-poll (25s on the server).
- `src/images.js` (the `/img?u=&r=` route) fetches images with the page as the Referer. It downscales them with sharp to fit 1024×3000 JPEGs, because iOS 5 has little RAM and won't decode huge images.
  Results are cached on disk by sha1 of the URL, and concurrent requests for the same image are deduplicated. When an image fails, the route serves a 1×1 placeholder GIF instead of an error.
- `public/reader.js` is the iPad client. It long-polls `/api/wait?since=<version>`, then fetches `/api/state` and `/api/doc/:id`. It has watchdogs and backoff for XHRs that hang after a screen lock.
  It keeps the scroll position for each document in localStorage and scrolls to `#ipad-send-continue` on first open.

## Constraints

- **`public/` must stay ES5 for Safari 5.1.** That means `var`, no arrow functions, no `Function.prototype.bind`, XHR instead of fetch, and every `localStorage` call wrapped in try/catch (it throws in Private Browsing). `npm run lint` enforces part of this, so run it after touching `public/`.
- Every `/api/*` response gets `Cache-Control: no-store`, because old iOS Safari caches XHRs. The reader also adds a `_=<timestamp>` cache-buster to each request.
- There is no auth. The server binds `0.0.0.0` for home-LAN use only. `extract()` sanitization is the only thing that stops page scripts from running on the iPad, so keep it strict.
- **Every change under `extension/` bumps `version` in `extension/manifest.json`** (semver: patch for fixes, minor for features).
  It also rewrites `description` to summarize the latest changes, e.g. `"Send the current page to the iPad reader. New in 1.1.0: <what changed>."`.
  Chrome caps `description` at 132 characters, so keep only the newest release in it.
- Tests exercise the Hono app through `app.request()`, with a temporary `dataDir` and an injected `fetchImpl`. The image proxy never touches the network in tests.
