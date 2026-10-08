import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { History } from "../src/history.js";

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "ipad-send-history-"));
const doc = (title) => ({ title, byline: null, url: `https://example.com/${title}`, raw: false, content: `<p>${title}</p>` });

test("every sent document goes straight to the screen", () => {
  const history = new History(tmpDir());

  history.push(doc("one"));
  const second = history.push(doc("two"));

  const state = history.snapshot();
  assert.equal(state.current.id, second.id);
  assert.equal(state.hasPrevious, true);
  assert.equal(state.hasNext, false);
  assert.equal(history.content(second.id), "<p>two</p>");
});

test("previous and next walk through older documents", () => {
  const history = new History(tmpDir());
  const first = history.push(doc("one"));
  const second = history.push(doc("two"));

  assert.equal(history.go(second.id, -1), true);
  assert.equal(history.snapshot().current.id, first.id);
  assert.deepEqual([history.snapshot().hasPrevious, history.snapshot().hasNext], [false, true]);

  assert.equal(history.go(first.id, 1), true);
  assert.equal(history.snapshot().current.id, second.id);
});

test("go refuses to step past either end, or from a stale document so a double tap does not skip one", () => {
  const history = new History(tmpDir());
  const first = history.push(doc("one"));
  const second = history.push(doc("two"));
  history.push(doc("three"));

  assert.equal(history.go(first.id, -1), false);
  assert.equal(history.go(second.id, -1), false);

  const third = history.snapshot().current;
  assert.equal(history.go(third.id, 1), false);
  assert.equal(history.go(third.id, 2), false);
  assert.equal(history.snapshot().current.id, third.id);
});

test("sending while viewing an older document jumps to the new one", () => {
  const history = new History(tmpDir());
  const first = history.push(doc("one"));
  history.push(doc("two"));
  history.go(history.snapshot().current.id, -1);
  assert.equal(history.snapshot().current.id, first.id);

  const third = history.push(doc("three"));

  assert.equal(history.snapshot().current.id, third.id);
  assert.equal(history.snapshot().hasNext, false);
});

test("state survives a server restart", () => {
  const dir = tmpDir();
  const first = new History(dir).push(doc("one"));

  const reloaded = new History(dir);

  assert.equal(reloaded.snapshot().current.id, first.id);
  assert.equal(reloaded.content(first.id), "<p>one</p>");
});

test("a legacy queue.json is carried over so old documents stay reachable", () => {
  const dir = tmpDir();
  const docs = Object.fromEntries(["a", "b", "c"].map((id) => [id, { id, title: id }]));
  fs.writeFileSync(path.join(dir, "queue.json"), JSON.stringify({ version: 7, current: "b", pending: ["c"], read: ["a"], docs }));

  const state = new History(dir).snapshot();

  assert.equal(state.current.id, "b");
  assert.deepEqual([state.hasPrevious, state.hasNext], [true, true]);
});

test("documents beyond the limit leave the history but stay archived on disk", () => {
  const dir = tmpDir();
  const history = new History(dir, { limit: 2 });
  const docs = ["a", "b", "c"].map((title) => history.push(doc(title)));

  assert.equal(history.content(docs[0].id), null);
  assert.equal(fs.readFileSync(path.join(dir, "docs", `${docs[0].id}.html`), "utf8"), "<p>a</p>");
  const archived = fs.readFileSync(path.join(dir, "archive.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(archived.map((d) => d.id), [docs[0].id]);
  assert.equal(archived[0].url, "https://example.com/a");
  assert.equal(history.content(docs[1].id), "<p>b</p>");
  history.go(docs[2].id, -1);
  assert.equal(history.snapshot().hasPrevious, false);
});

test("content() ignores ids it does not know, so ids can't be used to read arbitrary files", () => {
  const history = new History(tmpDir());

  assert.equal(history.content("../../etc/passwd"), null);
});

test("waitForChange resolves as soon as something is pushed", async () => {
  const history = new History(tmpDir());
  const since = history.version;

  const waiting = history.waitForChange(since, 5_000);
  history.push(doc("one"));

  assert.equal(await waiting, since + 1);
});

test("waitForChange returns immediately when the client is behind, and on timeout otherwise", async () => {
  const history = new History(tmpDir());
  history.push(doc("one"));

  assert.equal(await history.waitForChange(-1, 5_000), history.version);
  assert.equal(await history.waitForChange(history.version, 10), history.version);
});

test("pinning lists a document, unpinning removes it, unknown ids are ignored", () => {
  const dir = tmpDir();
  const history = new History(dir);
  const first = history.push(doc("one"));
  history.push(doc("two"));

  assert.equal(history.pin("nope", true), false);
  assert.equal(history.pin(first.id, true), true);
  assert.equal(history.pin(first.id, true), false);
  assert.deepEqual(history.snapshot().pinned, [{ id: first.id, title: "one", url: "https://example.com/one" }]);
  assert.deepEqual(new History(dir).snapshot().pinned.map((p) => p.id), [first.id]);

  assert.equal(history.pin(first.id, false), true);
  assert.deepEqual(history.snapshot().pinned, []);
});

test("a pinned document stays readable after it leaves the history, until it is unpinned", () => {
  const history = new History(tmpDir(), { limit: 2 });
  const first = history.push(doc("one"));
  const second = history.push(doc("two"));
  history.pin(first.id, true);
  history.push(doc("three"));
  history.push(doc("four"));

  assert.equal(history.content(first.id), "<p>one</p>");
  assert.equal(history.content(second.id), null);
  assert.equal(history.snapshot().pinned.length, 1);

  history.pin(first.id, false);
  assert.equal(history.content(first.id), null);
});

test("open makes a pinned document current even when it is outside the history", () => {
  const history = new History(tmpDir(), { limit: 1 });
  const first = history.push(doc("one"));
  history.pin(first.id, true);
  const second = history.push(doc("two"));

  const before = history.version;
  assert.equal(history.open("nope"), false);
  assert.equal(history.version, before);
  assert.equal(history.open(first.id), true);
  const state = history.snapshot();
  assert.equal(state.current.id, first.id);
  assert.deepEqual([state.hasPrevious, state.hasNext], [false, false]);
  assert.equal(history.open(second.id), true);
});

test("a history.json from before pinning loads with nothing pinned", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "history.json"), JSON.stringify({ version: 3, current: null, ids: [], docs: {} }));
  assert.deepEqual(new History(dir).snapshot().pinned, []);
});
