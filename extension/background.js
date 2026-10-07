const DEFAULT_SERVER = "http://localhost:7777";
const BADGE_MS = 2000;

async function serverUrl() {
  const { server } = await chrome.storage.sync.get({ server: DEFAULT_SERVER });
  return server.replace(/\/+$/, "");
}

// Runs inside the page, so it must be self-contained.
// For markdown files (raw, or on a GitHub blob page) it returns the source instead (see below).
// Otherwise puts numbered empty spans before the text visible in the window (0 = topmost) so the iPad can open
// at the same spot; the server keeps the topmost one that is part of the article (see src/extract.js).
async function grabPage() {
  const MARKER = "data-ipad-send-anchor";
  const MAX_MARKERS = 30;
  // Skip the top 10% of the window: sticky site headers usually cover it.
  const top = window.innerHeight * 0.1;
  const markers = [];

  // A raw markdown file shows as plain text in one <pre>. Send the source instead of the page, along with
  // the 1-based line at the top of the window, so the server can render it with pandoc and anchor there.
  const pre = document.querySelector("body > pre");
  const markdownType = /^text\/(x-)?markdown$/.test(document.contentType) ||
    (document.contentType === "text/plain" && /\.(md|markdown|mdown|mkd)$/i.test(location.pathname));
  if (pre && markdownType) {
    let line = 0;
    const hit = window.scrollY > 0 && document.caretRangeFromPoint(pre.getBoundingClientRect().left + 1, 2);
    if (hit && pre.contains(hit.startContainer)) {
      const before = document.createRange();
      before.setStart(pre, 0);
      before.setEnd(hit.startContainer, hit.startOffset);
      line = before.toString().split("\n").length;
    }
    return { url: location.href, title: document.title, markdown: pre.textContent, line };
  }

  // A markdown file on a GitHub blob page: send its source too, so it renders like the raw file does.
  const blobPath = /^(\/[^/]+\/[^/]+)\/blob\/.+\.(md|markdown|mdown|mkd)$/i;
  if (location.hostname === "github.com" && blobPath.test(location.pathname)) {
    const markdown = githubEmbeddedSource() ?? (await githubRawSource());
    if (markdown !== null) return { url: location.href, title: document.title, markdown, line: githubLine(markdown) };
  }

  // The page embeds the file's lines in its React payload. GitHub navigates without reloading, so the payload
  // may belong to a file seen earlier; only trust it when its path is the one in the address bar.
  function githubEmbeddedSource() {
    for (const script of document.querySelectorAll('script[data-target="react-app.embeddedData"]')) {
      try {
        const { payload } = JSON.parse(script.textContent);
        const { path, refInfo } = payload.codeViewBlobLayoutRoute;
        const { ownerLogin, name } = payload.codeViewLayoutRoute.repo;
        const lines = payload["codeViewBlobLayoutRoute.StyledBlob"].rawLines;
        const expected = `/${ownerLogin}/${name}/blob/${refInfo.name}/${path}`;
        if (Array.isArray(lines) && expected.toLowerCase() === decodeURIComponent(location.pathname).toLowerCase()) {
          return lines.join("\n");
        }
      } catch {
        // Not the blob payload, or GitHub changed its shape.
      }
    }
    return null;
  }

  // /raw/ redirects to raw.githubusercontent.com, with a token for private repos.
  async function githubRawSource() {
    try {
      const response = await fetch(location.pathname.replace(/^(\/[^/]+\/[^/]+)\/blob\//, "$1/raw/"));
      return response.ok ? await response.text() : null;
    } catch {
      return null;
    }
  }

  // GitHub's rendered markdown has no source positions, so find the topmost visible block's text in the source.
  // Text is compared as bare letters and digits, with list markers, link targets and tags dropped, to skip over
  // markdown syntax. A block's text must start at the start of a source line, but may run on to the next lines.
  function githubLine(markdown) {
    const body = document.querySelector("article.markdown-body");
    if (!body || window.scrollY === 0) return 0;
    const bare = (text) => text.replace(/\]\([^)]*\)|<[^>]*>/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
    const blocks = [...body.querySelectorAll("h1, h2, h3, h4, h5, h6, p, li, pre, tr")].filter((el) => bare(el.textContent));
    const index = blocks.findIndex((el) => el.getBoundingClientRect().bottom > top);
    if (index < 0) return 0;

    const key = bare(blocks[index].textContent).slice(0, 24);
    let source = "";
    const starts = markdown.split("\n").map((sourceLine) => {
      const start = source.length;
      source += bare(sourceLine.replace(/^[\s>]*([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, ""));
      return start;
    });
    const matches = starts.flatMap((start, i) => (source.startsWith(key, start) && starts[i + 1] !== start ? [i + 1] : []));
    // Repeated text (e.g. two "Setup" headings): take the same occurrence in the source.
    const occurrence = blocks.slice(0, index).filter((el) => bare(el.textContent).startsWith(key)).length;
    return matches[occurrence] ?? matches[0] ?? 0;
  }

  const pinned = new Map();
  const isPinned = (el) => {
    if (!el) return false;
    if (!pinned.has(el)) {
      const { position } = getComputedStyle(el);
      pinned.set(el, position === "fixed" || position === "sticky" || isPinned(el.parentElement));
    }
    return pinned.get(el);
  };

  if (window.scrollY > 0) {
    const visible = [];
    const range = document.createRange();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.data.trim() || /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA)$/.test(node.parentElement.tagName)) continue;
      range.selectNodeContents(node);
      const rect = range.getBoundingClientRect();
      if (rect.height === 0 || rect.bottom <= top || rect.top >= window.innerHeight) continue;
      if (isPinned(node.parentElement)) continue; // site headers, sidebars, cookie bars
      visible.push({ node, top: rect.top, left: rect.left });
    }
    visible.sort((a, b) => a.top - b.top || a.left - b.left);
    for (const { node } of visible.slice(0, MAX_MARKERS)) {
      const marker = document.createElement("span");
      marker.setAttribute(MARKER, String(markers.length));
      node.parentNode.insertBefore(marker, node);
      markers.push(marker);
    }
  }

  try {
    return { url: location.href, title: document.title, html: document.documentElement.outerHTML };
  } finally {
    markers.forEach((marker) => marker.remove());
  }
}

async function flash(tabId, text, color) {
  await chrome.action.setBadgeBackgroundColor({ tabId, color });
  await chrome.action.setBadgeText({ tabId, text });
  setTimeout(() => chrome.action.setBadgeText({ tabId, text: "" }), BADGE_MS);
}

async function sendTab(tab) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: grabPage });
    const response = await fetch(`${await serverUrl()}/api/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(result),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Server responded ${response.status}`);
    await flash(tab.id, "✓", "#22aa22");
  } catch (error) {
    await flash(tab.id, "✗", "#cc3333").catch(() => {});
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icon-128.png",
      title: "Send to iPad failed",
      message: error.message,
    });
  }
}

chrome.action.onClicked.addListener(sendTab);

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== "send-to-ipad") return;
  const target = tab ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (target) sendTab(target);
});
