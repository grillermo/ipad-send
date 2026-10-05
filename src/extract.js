import { Readability } from "@mozilla/readability";
import { JSDOM, VirtualConsole } from "jsdom";

const STRIP_SELECTOR = "script, style, noscript, iframe, object, embed, svg, video, audio, canvas, " +
  "form, input, textarea, select, meta, link, base, applet, frame, frameset, template, math";
const DROPPED_ATTRIBUTES = new Set(["style", "formaction", "action", "srcdoc", "xlink:href"]);
const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const SAFE_DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp)[;,]/i;
const LAZY_SRC_ATTRIBUTES = ["data-src", "data-original", "data-lazy-src", "data-url"];
const MAX_SRCSET_WIDTH = 2048;
const MIN_ARTICLE_TEXT = 140;
// The extension puts numbered empty spans before the text visible in Chrome, 0 = topmost.
// The lowest-numbered one that survives extraction becomes ANCHOR_ID, which the iPad scrolls to.
const ANCHOR_MARKER = "data-ipad-send-anchor";
const ANCHOR_ID = "ipad-send-continue";

export function extract(html, pageUrl, { imageUrl }) {
  const document = load(html, pageUrl);

  // Readability mutates the document it reads, so give it a copy and keep the original for the fallback.
  const article = new Readability(document.cloneNode(true)).parse();
  const raw = !article || article.textContent.trim().length < MIN_ARTICLE_TEXT;
  const body = raw ? (document.body?.innerHTML ?? "") : article.content;

  return {
    title: (!raw && article.title) || document.title || null,
    byline: raw ? null : article.byline || null,
    content: sanitize(document, body, imageUrl),
    raw,
  };
}

// html is pandoc output for a markdown file (see src/markdown.js), so it is already just the article.
// line is the 1-based source line at the top of Chrome's window. The anchor goes before the first (outermost)
// element on the closest line that starts at or before it.
export function extractMarkdown(html, pageUrl, { imageUrl, line }) {
  const document = load(html, pageUrl);
  const positioned = [...document.body.querySelectorAll("[data-pos]")];

  if (line > 0) {
    const closest = Math.max(0, ...positioned.map(startLine).filter((start) => start !== null && start <= line));
    const target = positioned.find((el) => startLine(el) === closest);
    if (target) {
      const marker = document.createElement("span");
      marker.setAttribute(ANCHOR_MARKER, "0");
      target.before(marker);
    }
  }
  // Pandoc wraps every word in a span for sourcepos; unwrap them so the iPad doesn't carry that DOM.
  document.body.querySelectorAll("span[data-wrapper]").forEach((span) => span.replaceWith(...span.childNodes));
  positioned.forEach((el) => el.removeAttribute("data-pos"));

  return {
    title: document.querySelector("h1")?.textContent.trim() || fileName(pageUrl),
    byline: null,
    content: sanitize(document, document.body.innerHTML, imageUrl),
    raw: false,
  };
}

export function pickFromSrcset(srcset) {
  if (!srcset) return null;
  const candidates = srcset
    .split(/,\s+/)
    .map((part) => {
      const [url, descriptor = "1x"] = part.trim().split(/\s+/);
      return { url, size: parseFloat(descriptor) || 1 };
    })
    .filter((candidate) => candidate.url)
    .sort((a, b) => a.size - b.size);
  const fitting = candidates.filter((candidate) => candidate.size <= MAX_SRCSET_WIDTH);
  return (fitting.at(-1) ?? candidates[0])?.url ?? null;
}

function load(html, pageUrl) {
  // Silent VirtualConsole: JSDOM otherwise logs every CSS parse error to stderr.
  const { document } = new JSDOM(html, { url: baseUrl(pageUrl), virtualConsole: new VirtualConsole() }).window;
  document.querySelectorAll(STRIP_SELECTOR).forEach((el) => el.remove());
  resolveLazyImages(document);
  absolutizeUrls(document);
  return document;
}

function startLine(el) {
  const match = /(\d+):\d+-/.exec(el.getAttribute("data-pos"));
  return match ? Number(match[1]) : null;
}

function fileName(pageUrl) {
  try {
    return decodeURIComponent(new URL(pageUrl).pathname.split("/").pop()) || null;
  } catch {
    return null;
  }
}

function baseUrl(pageUrl) {
  try {
    return new URL(pageUrl).href;
  } catch {
    return "about:blank";
  }
}

function resolveLazyImages(document) {
  for (const img of document.querySelectorAll("img")) {
    const lazy = LAZY_SRC_ATTRIBUTES.map((name) => img.getAttribute(name)).find(Boolean);
    const best = pickFromSrcset(img.getAttribute("srcset") || img.getAttribute("data-srcset"));
    const src = best || lazy;
    if (src) img.setAttribute("src", src);
    img.removeAttribute("srcset");
    img.removeAttribute("sizes");
  }
  document.querySelectorAll("picture source").forEach((el) => el.remove());
}

function absolutizeUrls(document) {
  // JSDOM resolves .href/.src against the page URL passed to the constructor.
  for (const a of document.querySelectorAll("a[href], area[href]")) a.setAttribute("href", a.href);
  for (const img of document.querySelectorAll("img[src]")) img.setAttribute("src", img.src);
}

function sanitize(document, html, imageUrl) {
  const container = document.createElement("div");
  container.innerHTML = html;
  placeAnchor(container);

  for (const el of container.querySelectorAll("*")) {
    for (const { name } of [...el.attributes]) {
      if (name.toLowerCase().startsWith("on") || DROPPED_ATTRIBUTES.has(name.toLowerCase())) el.removeAttribute(name);
    }
  }
  for (const a of container.querySelectorAll("a[href], area[href]")) {
    if (isSafeLink(a.getAttribute("href"))) a.setAttribute("target", "_blank");
    else a.removeAttribute("href");
  }
  for (const img of container.querySelectorAll("img")) {
    const src = (img.getAttribute("src") || "").trim();
    if (/^https?:\/\//i.test(src)) img.setAttribute("src", imageUrl(src));
    else if (!SAFE_DATA_IMAGE.test(src)) img.remove(); // data: images deliberately bypass the proxy
    img.removeAttribute("width");
    img.removeAttribute("height");
  }
  return container.innerHTML;
}

function placeAnchor(container) {
  container.querySelectorAll(`#${ANCHOR_ID}`).forEach((el) => el.removeAttribute("id"));
  const markers = [...container.querySelectorAll(`span[${ANCHOR_MARKER}]`)];
  const order = (el) => Number(el.getAttribute(ANCHOR_MARKER)) || 0;
  const topmost = markers.reduce((best, el) => (!best || order(el) < order(best) ? el : best), null);
  for (const el of markers) {
    if (el === topmost) {
      el.removeAttribute(ANCHOR_MARKER);
      el.setAttribute("id", ANCHOR_ID);
    } else {
      el.remove();
    }
  }
}

function isSafeLink(href) {
  try {
    // The URL parser strips tabs/newlines and lowercases the scheme, like browsers do.
    return SAFE_LINK_PROTOCOLS.has(new URL(href.trim()).protocol);
  } catch {
    return false;
  }
}
