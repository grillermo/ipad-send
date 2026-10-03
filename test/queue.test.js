import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Queue } from "../src/queue.js";

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "ipad-send-queue-"));
const doc = (title) => ({ title, byline: null, url: `https://example.com/${title}`, raw: false, content: `<p>${title}</p>` });

test("first document goes straight to the screen, later ones wait in line", () => {
  const queue = new Queue(tmpDir());

  const first = queue.push(doc("one"));
  queue.push(doc("two"));

  const state = queue.snapshot();
  assert.equal(state.current.id, first.id);
  assert.equal(state.queued, 1);
  assert.equal(queue.content(first.id), "<p>one</p>");
});

test("advance shows the next document, and a stale double tap does not skip one", () => {
  const queue = new Queue(tmpDir());
  const first = queue.push(doc("one"));
  const second = queue.push(doc("two"));
  queue.push(doc("three"));

  assert.equal(queue.advance(first.id), true);
  assert.equal(queue.advance(first.id), false);

  assert.equal(queue.snapshot().current.id, second.id);
  assert.equal(queue.snapshot().queued, 1);
});

test("advancing past the last document empties the screen so the next send shows instantly", () => {
  const queue = new Queue(tmpDir());
  const only = queue.push(doc("one"));

  queue.advance(only.id);
  const next = queue.push(doc("two"));

  assert.equal(queue.snapshot().current.id, next.id);
});

test("state survives a server restart", () => {
  const dir = tmpDir();
  const first = new Queue(dir).push(doc("one"));

  const reloaded = new Queue(dir);

  assert.equal(reloaded.snapshot().current.id, first.id);
  assert.equal(reloaded.content(first.id), "<p>one</p>");
});

test("read documents beyond the limit are deleted so the disk does not fill up", () => {
  const queue = new Queue(tmpDir(), { readLimit: 2 });
  const docs = ["a", "b", "c", "d"].map((title) => queue.push(doc(title)));

  for (const { id } of docs.slice(0, 3)) queue.advance(id);

  assert.equal(queue.content(docs[0].id), null);
  assert.equal(queue.content(docs[1].id), "<p>b</p>");
});

test("content() ignores ids it does not know, so ids can't be used to read arbitrary files", () => {
  const queue = new Queue(tmpDir());

  assert.equal(queue.content("../../etc/passwd"), null);
});

test("waitForChange resolves as soon as something is pushed", async () => {
  const queue = new Queue(tmpDir());
  const since = queue.version;

  const waiting = queue.waitForChange(since, 5_000);
  queue.push(doc("one"));

  assert.equal(await waiting, since + 1);
});

test("waitForChange returns immediately when the client is behind, and on timeout otherwise", async () => {
  const queue = new Queue(tmpDir());
  queue.push(doc("one"));

  assert.equal(await queue.waitForChange(-1, 5_000), queue.version);
  assert.equal(await queue.waitForChange(queue.version, 10), queue.version);
});
