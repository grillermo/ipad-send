import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extract, pickFromSrcset } from "../src/extract.js";

const fixture = readFileSync(new URL("./fixtures/article.html", import.meta.url), "utf8");
const PAGE_URL = "https://example.com/blog/tides";
const imageUrl = (src) => `/img?u=${encodeURIComponent(src)}`;

test("keeps the article and drops page chrome, so the iPad shows only what you want to read", () => {
  const result = extract(fixture, PAGE_URL, { imageUrl });

  assert.equal(result.title, "How Tides Work");
  assert.equal(result.raw, false);
  assert.match(result.content, /gravitational pull of the moon/);
  assert.doesNotMatch(result.content, /Site navigation/);
});

test("strips scripts, inline handlers and javascript: links so page code never runs on the iPad", () => {
  const { content } = extract(fixture, PAGE_URL, { imageUrl });

  assert.doesNotMatch(content, /<script/i);
  assert.doesNotMatch(content, /onclick/i);
  assert.doesNotMatch(content, /javascript:/i);
});

test("makes links absolute and opens them outside the reader, because relative links would hit our server", () => {
  const { content } = extract(fixture, PAGE_URL, { imageUrl });

  assert.match(content, /href="https:\/\/example\.com\/about" target="_blank"/);
});

test("routes lazy-loaded and srcset images through the proxy with absolute URLs", () => {
  const { content } = extract(fixture, PAGE_URL, { imageUrl });

  assert.ok(content.includes(imageUrl("https://example.com/images/moon.jpg")), "lazy data-src image");
  assert.ok(content.includes(imageUrl("https://example.com/images/coast-1600.jpg")), "best srcset candidate");
  assert.doesNotMatch(content, /srcset/);
});

test("pickFromSrcset prefers the largest candidate that is still at most 2048 wide", () => {
  assert.equal(pickFromSrcset("a.jpg 400w, b.jpg 1600w, c.jpg 3000w"), "b.jpg");
  assert.equal(pickFromSrcset("a.jpg 1x, b.jpg 2x"), "b.jpg");
  assert.equal(pickFromSrcset("a.jpg 3000w, b.jpg 4000w"), "a.jpg");
  assert.equal(pickFromSrcset(null), null);
});

test("falls back to the raw page body when Readability finds no article, instead of sending nothing", () => {
  const html = "<html><head><title>Login</title></head><body><button>Sign in</button></body></html>";
  const result = extract(html, PAGE_URL, { imageUrl });

  assert.equal(result.raw, true);
  assert.equal(result.title, "Login");
  assert.match(result.content, /Sign in/);
});
