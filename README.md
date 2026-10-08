# ipad-send

Send the current Chrome tab to a 1st-gen iPad (iOS 5.1.1) as clean, readable HTML.

## Setup

```bash
pnpm install
./serve                         # (re)starts the server on :7777 in tmux session "ipad-send"
```

- Chrome: `chrome://extensions` → Developer mode → Load unpacked → `extension/`.
  Default hotkey `⌥⇧I`; change it at `chrome://extensions/shortcuts`.
  Server URL (default `http://localhost:7777`) is in the extension options; point it
  at `http://<server-host>.local:7777` when the server runs on another machine.
- iPad: open `http://<LocalHostName>.local:7777` in Safari → Share → Add to Home Screen.
  If `.local` doesn't resolve, use the Mac's LAN IP.

## Use

Hotkey → the page shows on the iPad right away, replacing whatever was on screen, and opens
scrolled to the text that was at the top of your Chrome window.
"‹ Previous" goes back to older documents; "Next ›" appears while you're on one.

## Dev

```bash
pnpm test        # node:test suite
pnpm run lint    # ES5 check for the iPad script
pnpm start       # foreground server
tmux kill-session -t ipad-send   # stop ./serve
tail -f log/server.log
```

Data lives in `data/` (history.json, docs/, images/); delete it to reset.

## Limits

- No auth: anyone on the LAN can send or read. Home Wi-Fi only.
- Images are fetched by the server with only a Referer header, so images that need your cookies show as blanks.
- If the Mac sleeps, the iPad shows the grey "offline" dot and reconnects when the Mac wakes.
