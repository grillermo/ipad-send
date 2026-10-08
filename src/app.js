import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { serveStatic } from "@hono/node-server/serve-static";
import { extract, extractMarkdown } from "./extract.js";
import { markdownToHtml } from "./markdown.js";
import { createImageProxy, proxiedImageUrl, PLACEHOLDER_GIF } from "./images.js";
import { History } from "./history.js";

const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));
const MAX_PAGE_BYTES = 20 * 1024 * 1024;

export function createApp({ dataDir, waitTimeoutMs = 25_000, fetchImpl = fetch }) {
  const history = new History(dataDir);
  const getImage = createImageProxy({ cacheDir: path.join(dataDir, "images"), fetchImpl });
  const app = new Hono();

  app.use("/api/*", async (c, next) => {
    await next();
    c.res.headers.set("Cache-Control", "no-store");
  });

  app.post(
    "/api/send",
    bodyLimit({ maxSize: MAX_PAGE_BYTES, onError: (c) => c.json({ error: "Page is larger than 20MB" }, 413) }),
    async (c) => {
      // The extension sends markdown (plus the line on screen) instead of html for raw .md files.
      const { url, title, html, markdown, line } = (await c.req.json().catch(() => null)) ?? {};
      const isMarkdown = typeof markdown === "string";
      if (!isMarkdown && (typeof html !== "string" || !html)) return c.json({ error: "Missing html" }, 400);

      if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return c.json({ error: "url must be http(s)" }, 400);

      const startedAt = performance.now();
      const imageUrl = (src) => proxiedImageUrl(src, url);
      let article;
      if (isMarkdown) {
        try {
          article = extractMarkdown(await markdownToHtml(markdown), url, { imageUrl, line: Number(line) || 0 });
        } catch (error) {
          console.error(`[send] pandoc: ${error.message}`);
          return c.json({ error: `pandoc failed: ${error.message}` }, 500);
        }
      } else {
        article = extract(html, url, { imageUrl });
      }
      const doc = history.push({ ...article, url, title: article.title || title || url });
      console.log(`[send] ${Math.round(performance.now() - startedAt)}ms raw=${doc.raw} markdown=${isMarkdown} ${url}`);

      return c.json({ id: doc.id, title: doc.title, raw: doc.raw }, 201);
    },
  );

  app.get("/api/state", (c) => c.json(history.snapshot()));

  app.get("/api/doc/:id", (c) => {
    const html = history.content(c.req.param("id"));
    return html === null ? c.json({ error: "Not found" }, 404) : c.html(html);
  });

  app.post("/api/go", async (c) => {
    const { from, step } = (await c.req.json().catch(() => null)) ?? {};
    history.go(from, step);
    return c.json(history.snapshot());
  });

  app.post("/api/pin", async (c) => {
    const { id, pinned } = (await c.req.json().catch(() => null)) ?? {};
    history.pin(id, pinned === true);
    return c.json(history.snapshot());
  });

  app.post("/api/open", async (c) => {
    const { id } = (await c.req.json().catch(() => null)) ?? {};
    history.open(id);
    return c.json(history.snapshot());
  });

  app.get("/api/wait", async (c) => {
    const version = await history.waitForChange(Number(c.req.query("since")), waitTimeoutMs);
    return c.json({ version });
  });

  app.get("/img", async (c) => {
    const url = c.req.query("u");
    const placeholder = () => c.body(PLACEHOLDER_GIF, 200, { "Content-Type": "image/gif", "Cache-Control": "no-store" });
    if (!url || !/^https?:\/\//.test(url)) return placeholder();

    try {
      const image = await getImage(url, c.req.query("r"));
      return c.body(image, 200, { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=31536000" });
    } catch (error) {
      console.error(`[img] ${error.message}`);
      return placeholder();
    }
  });

  // Without this iOS 5 Safari keeps running a stale reader.js after a deploy. no-cache still lets it
  // revalidate with Last-Modified, so an unchanged file costs a 304.
  app.use("/*", async (c, next) => {
    await next();
    if (!c.res.headers.has("Cache-Control")) c.res.headers.set("Cache-Control", "no-cache");
  });

  // iPads that cached reader.js before it was sent no-cache keep reusing that copy, so the page asks for
  // the scripts and styles under a new URL whenever the file changes.
  app.get("/", (c) => {
    const html = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8").replace(
      /(src|href)="\/(reader\.(?:js|css))"/g,
      (_, attr, file) => `${attr}="/${file}?v=${Math.trunc(fs.statSync(path.join(PUBLIC_DIR, file)).mtimeMs)}"`,
    );
    return c.html(html);
  });
  app.use("/*", serveStatic({ root: PUBLIC_DIR }));

  return { app, history };
}
