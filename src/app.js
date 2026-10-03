import path from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { serveStatic } from "@hono/node-server/serve-static";
import { extract } from "./extract.js";
import { createImageProxy, proxiedImageUrl, PLACEHOLDER_GIF } from "./images.js";
import { Queue } from "./queue.js";

const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));
const MAX_PAGE_BYTES = 20 * 1024 * 1024;

export function createApp({ dataDir, waitTimeoutMs = 25_000, fetchImpl = fetch }) {
  const queue = new Queue(dataDir);
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
      const { url, title, html } = (await c.req.json().catch(() => null)) ?? {};
      if (typeof html !== "string" || !html) return c.json({ error: "Missing html" }, 400);

      if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return c.json({ error: "url must be http(s)" }, 400);

      const startedAt = performance.now();
      const article = extract(html, url, { imageUrl: (src) => proxiedImageUrl(src, url) });
      const doc = queue.push({ ...article, url, title: article.title || title || url });
      console.log(`[send] ${Math.round(performance.now() - startedAt)}ms raw=${doc.raw} ${url}`);

      return c.json({ id: doc.id, title: doc.title, raw: doc.raw, queued: queue.snapshot().queued }, 201);
    },
  );

  app.get("/api/state", (c) => c.json(queue.snapshot()));

  app.get("/api/doc/:id", (c) => {
    const html = queue.content(c.req.param("id"));
    return html === null ? c.json({ error: "Not found" }, 404) : c.html(html);
  });

  app.post("/api/advance", async (c) => {
    const { from } = (await c.req.json().catch(() => null)) ?? {};
    queue.advance(from);
    return c.json(queue.snapshot());
  });

  app.get("/api/wait", async (c) => {
    const version = await queue.waitForChange(Number(c.req.query("since")), waitTimeoutMs);
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

  app.use("/*", serveStatic({ root: PUBLIC_DIR }));

  return { app, queue };
}
