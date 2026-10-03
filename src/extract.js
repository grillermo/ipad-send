import { Readability } from "@mozilla/readability";
import { JSDOM, VirtualConsole } from "jsdom";

const STRIP_SELECTOR = "script, style, noscript, iframe, object, embed, svg, video, audio, canvas";
const LAZY_SRC_ATTRIBUTES = ["data-src", "data-original", "data-lazy-src", "data-url"];
const MAX_SRCSET_WIDTH = 2048;
const MIN_ARTICLE_TEXT = 140;

export function extract(html, pageUrl, { imageUrl }) {
  // Silent VirtualConsole: JSDOM otherwise logs every CSS parse error to stderr.
  const { document } = new JSDOM(html, { url: baseUrl(pageUrl), virtualConsole: new VirtualConsole() }).window;
  document.querySelectorAll(STRIP_SELECTOR).forEach((el) => el.remove());
  resolveLazyImages(document);
  absolutizeUrls(document);

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
  for (const a of document.querySelectorAll("a[href]")) a.setAttribute("href", a.href);
  for (const img of document.querySelectorAll("img[src]")) img.setAttribute("src", img.src);
}

function sanitize(document, html, imageUrl) {
  const container = document.createElement("div");
  container.innerHTML = html;

  for (const el of container.querySelectorAll("*")) {
    for (const { name } of [...el.attributes]) {
      if (name.startsWith("on") || name === "style") el.removeAttribute(name);
    }
  }
  for (const a of container.querySelectorAll("a[href]")) {
    if (/^javascript:/i.test(a.getAttribute("href"))) a.removeAttribute("href");
    else a.setAttribute("target", "_blank");
  }
  for (const img of container.querySelectorAll("img")) {
    const src = img.getAttribute("src") || "";
    if (/^https?:\/\//.test(src)) img.setAttribute("src", imageUrl(src));
    else if (!src.startsWith("data:")) img.remove();
    img.removeAttribute("width");
    img.removeAttribute("height");
  }
  return container.innerHTML;
}
