import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";

const fixture = fs.readFileSync(new URL("./fixtures/article.html", import.meta.url), "utf8");
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "ipad-send-app-"));
const failingFetch = async () => new Response("nope", { status: 404 });

function build(options = {}) {
  return createApp({ dataDir: tmpDir(), waitTimeoutMs: 1_000, fetchImpl: failingFetch, ...options }).app;
}

function send(app, body = { url: "https://example.com/blog/tides", title: "Tab title", html: fixture }) {
  return app.request("/api/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const json = async (response) => (await response).json();
const post = (app, path, body) =>
  app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body });

test("a sent page becomes the current document with readable, proxied content", async () => {
  const app = build();

  const sent = await send(app);
  assert.equal(sent.status, 201);
  const { id } = await sent.json();

  const state = await json(app.request("/api/state"));
  assert.equal(state.current.id, id);
  assert.equal(state.current.title, "How Tides Work");
  assert.equal(state.current.url, "https://example.com/blog/tides");

  const doc = await app.request(`/api/doc/${id}`);
  const html = await doc.text();
  assert.match(html, /gravitational pull of the moon/);
  assert.match(html, /src="\/img\?u=https%3A%2F%2Fexample\.com%2Fimages%2Fmoon\.jpg/);
});

test("rejects a send without html", async () => {
  const response = await send(build(), { url: "https://example.com" });

  assert.equal(response.status, 400);
});

test("rejects a send whose url is not http(s)", async () => {
  for (const url of ["javascript:alert(1)", "data:text/html,x", "ftp://x.com", "", 5, null, undefined]) {
    const response = await send(build(), { url, title: "t", html: fixture });
    assert.equal(response.status, 400, `url: ${url}`);
  }
});

test("a waiting iPad is woken up by a send", async () => {
  const app = build();
  const { version } = await json(app.request("/api/state"));

  const waiting = json(app.request(`/api/wait?since=${version}`));
  await send(app);

  assert.equal((await waiting).version, version + 1);
});

test("previous and next move through sent documents", async () => {
  const app = build();
  const first = await json(send(app));
  const second = await json(send(app));
  const go = (from, step) => json(post(app, "/api/go", JSON.stringify({ from, step })));

  const back = await go(second.id, -1);
  assert.equal(back.current.id, first.id);
  assert.deepEqual([back.hasPrevious, back.hasNext], [false, true]);

  const forward = await go(first.id, 1);
  assert.equal(forward.current.id, second.id);
  assert.deepEqual([forward.hasPrevious, forward.hasNext], [true, false]);
});

test("api responses are never cached, because old iOS Safari caches XHRs", async () => {
  const response = await build().request("/api/state");

  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("a broken image becomes a placeholder instead of an error, so the article still renders", async () => {
  const response = await build().request(`/img?u=${encodeURIComponent("https://cdn.example.com/x.png")}`);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "image/gif");
});

test("the reader page is served at /", async () => {
  const response = await build().request("/");

  assert.equal(response.status, 200);
  assert.match(await response.text(), /reader\.js/);
});

test("send rejects malformed json, an empty body, null and non-string html with 400", async () => {
  const app = build();

  for (const body of ["{not json", "", "null", JSON.stringify({ html: 42 })]) {
    assert.equal((await post(app, "/api/send", body)).status, 400, `body: ${body}`);
  }
});

test("go with a null body returns the unchanged state", async () => {
  const app = build();
  const { id } = await json(send(app));

  const response = await post(app, "/api/go", "null");

  assert.equal(response.status, 200);
  assert.equal((await response.json()).current.id, id);
});

test("a sent markdown file is rendered with pandoc and anchored at the line on screen", async () => {
  const app = build();
  const url = "https://example.com/notes/plan.md";

  const sent = await send(app, { url, title: "plan.md", markdown: "# Plan\n\nIntro.\n\n## Later\n\nMore.\n", line: 5 });
  assert.equal(sent.status, 201);
  const { id, title } = await sent.json();
  assert.equal(title, "Plan");

  const html = await (await app.request(`/api/doc/${id}`)).text();
  assert.match(html, /<span id="ipad-send-continue"><\/span><h2[^>]*>Later/);
});
