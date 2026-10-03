# ipad-send

Send the current Chrome tab to a 1st-gen iPad (iOS 5.1.1) as clean, readable HTML.

## Setup

```bash
npm install
./script/install-launchd        # runs the server at login on :7777
```

- Chrome: `chrome://extensions` → Developer mode → Load unpacked → `extension/`.
  Default hotkey `⌥⇧I`; change it at `chrome://extensions/shortcuts`.
  Server URL (default `http://localhost:7777`) is in the extension options.
- iPad: open `http://<LocalHostName>.local:7777` in Safari → Share → Add to Home Screen.
  If `.local` doesn't resolve, use the Mac's LAN IP.

## Use

Hotkey → the page shows on the iPad. If you're already reading, it's queued: tap
"N queued ›" for the next one, or "Done" to clear the screen.

## Dev

```bash
npm test        # node:test suite
npm run lint    # ES5 check for the iPad script
npm start       # foreground server
tail -f log/server.log
```

Data lives in `data/` (queue.json, docs/, images/); delete it to reset.

## Limits

- No auth: anyone on the LAN can send or read. Home Wi-Fi only.
- Images are fetched by the server with only a Referer header, so images that need your cookies show as blanks.
- If the Mac sleeps, the iPad shows the grey "offline" dot and reconnects when the Mac wakes.
