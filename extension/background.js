const DEFAULT_SERVER = "http://localhost:7777";
const BADGE_MS = 2000;

async function serverUrl() {
  const { server } = await chrome.storage.sync.get({ server: DEFAULT_SERVER });
  return server.replace(/\/+$/, "");
}

// Runs inside the page, so it must be self-contained.
// Marks the topmost visible text block so the iPad opens at the same spot (see src/extract.js).
function grabPage() {
  const MARKER = "data-ipad-send-anchor";
  const BLOCKS = "p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, dd, dt, figcaption";
  // Skip the top 10% of the window: sticky site headers usually cover it.
  const top = window.innerHeight * 0.1;
  const anchor = window.scrollY > 0 && [...document.querySelectorAll(BLOCKS)].find((el) => {
    if (el.querySelector(BLOCKS) || !el.textContent.trim()) return false; // innermost blocks with text only
    const rect = el.getBoundingClientRect();
    return rect.height > 0 && rect.bottom > top && rect.top < window.innerHeight;
  });
  if (anchor) anchor.setAttribute(MARKER, "");
  try {
    return { url: location.href, title: document.title, html: document.documentElement.outerHTML };
  } finally {
    if (anchor) anchor.removeAttribute(MARKER);
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
