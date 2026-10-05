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
// Set by the extension on the topmost block visible in Chrome; becomes ANCHOR_ID in the output.
const ANCHOR_MARKER = "data-ipad-send-anchor";
const ANCHOR_ID = "ipad-send-continue";
const BLOCK_SELECTOR = "p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, dd, dt, figcaption";

export function extract(html, pageUrl, { imageUrl }) {
  // Silent VirtualConsole: JSDOM otherwise logs every CSS parse error to stderr.
  const { document } = new JSDOM(html, { url: baseUrl(pageUrl), virtualConsole: new VirtualConsole() }).window;
  document.querySelectorAll(STRIP_SELECTOR).forEach((el) => el.remove());
  resolveLazyImages(document);
  absolutizeUrls(document);
  const anchorText = normalizedText(document.querySelector(`[${ANCHOR_MARKER}]`));

  // Readability mutates the document it reads, so give it a copy and keep the original for the fallback.
  const article = new Readability(document.cloneNode(true)).parse();
  const raw = !article || article.textContent.trim().length < MIN_ARTICLE_TEXT;
  const body = raw ? (document.body?.innerHTML ?? "") : article.content;

  return {
    title: (!raw && article.title) || document.title || null,
    byline: raw ? null : article.byline || null,
    content: sanitize(document, body, imageUrl, anchorText),
    raw,
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

function sanitize(document, html, imageUrl, anchorText) {
  const container = document.createElement("div");
  container.innerHTML = html;
  placeAnchor(container, anchorText);

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

// Readability rebuilds some elements (div → p) without their attributes, so fall back to matching the text.
function placeAnchor(container, anchorText) {
  container.querySelectorAll(`#${ANCHOR_ID}`).forEach((el) => el.removeAttribute("id"));
  const anchor =
    container.querySelector(`[${ANCHOR_MARKER}]`) ??
    (anchorText && [...container.querySelectorAll(BLOCK_SELECTOR)].find((el) => normalizedText(el) === anchorText));
  container.querySelectorAll(`[${ANCHOR_MARKER}]`).forEach((el) => el.removeAttribute(ANCHOR_MARKER));
  anchor?.setAttribute("id", ANCHOR_ID);
}

function normalizedText(el) {
  return el?.textContent.replace(/\s+/g, " ").trim() || null;
}

function isSafeLink(href) {
  try {
    // The URL parser strips tabs/newlines and lowercases the scheme, like browsers do.
    return SAFE_LINK_PROTOCOLS.has(new URL(href.trim()).protocol);
  } catch {
    return false;
  }
}
