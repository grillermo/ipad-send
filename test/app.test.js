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

test("a waiting iPad is woken up by a send", async () => {
  const app = build();
  const { version } = await json(app.request("/api/state"));

  const waiting = json(app.request(`/api/wait?since=${version}`));
  await send(app);

  assert.equal((await waiting).version, version + 1);
});

test("advance moves to the queued document", async () => {
  const app = build();
  const first = await json(send(app));
  const second = await json(send(app));

  const state = await json(
    app.request("/api/advance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: first.id }),
    }),
  );

  assert.equal(state.current.id, second.id);
  assert.equal(state.queued, 0);
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
