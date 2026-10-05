const DEFAULT_SERVER = "http://localhost:7777";
const BADGE_MS = 2000;

async function serverUrl() {
  const { server } = await chrome.storage.sync.get({ server: DEFAULT_SERVER });
  return server.replace(/\/+$/, "");
}

// Runs inside the page, so it must be self-contained.
// Puts numbered empty spans before the text visible in the window (0 = topmost) so the iPad can open
// at the same spot; the server keeps the topmost one that is part of the article (see src/extract.js).
function grabPage() {
  const MARKER = "data-ipad-send-anchor";
  const MAX_MARKERS = 30;
  // Skip the top 10% of the window: sticky site headers usually cover it.
  const top = window.innerHeight * 0.1;
  const markers = [];

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
