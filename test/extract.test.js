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

const LONG = "Tides are caused mostly by the gravitational pull of the moon, which tugs on the oceans and raises a bulge of water. ".repeat(3);
const page = (inner) => `<html><head><title>T</title></head><body><article><h1>T</h1><p>${LONG}</p>${inner}</article></body></html>`;

test("removes href from links with obfuscated or non-allow-listed schemes", () => {
  const inner = `<p>
    <a href="JaVaScRiPt:alert(1)">a</a>
    <a href="  java&#9;script:alert(2)">b</a>
    <a href="jav&#x09;ascript:alert(3)">c</a>
    <a href="vbscript:msgbox(1)">d</a>
    <a href="data:text/html,<script>alert(4)</script>">e</a>
    <a href="mailto:a@example.com">ok</a>
    <a href="/safe">safe</a>
  </p><p>${LONG}</p>`;
  const { content } = extract(page(inner), PAGE_URL, { imageUrl });

  assert.doesNotMatch(content, /javascript:|vbscript:|data:text/i);
  assert.match(content, /href="mailto:a@example\.com"/);
  assert.match(content, /href="https:\/\/example\.com\/safe"/);
});

test("drops forms, form actions, meta refresh and base so the page cannot redirect or post", () => {
  const inner = `<form action="https://evil.example/post"><input name="x"><button formaction="https://evil.example/x">Go</button></form>
    <meta http-equiv="refresh" content="0;url=https://evil.example"><base href="https://evil.example/">
    <p>${LONG}</p>`;
  const { content } = extract(page(inner), PAGE_URL, { imageUrl });

  assert.doesNotMatch(content, /<form|<input|<meta|<base|formaction|action=|evil\.example/i);
});

test("keeps only raster data: images and removes svg or html data: images", () => {
  const inner = `<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" alt="svg">
    <img src="data:text/html;base64,PHNjcmlwdD4=" alt="html">
    <img src="data:image/png;base64,iVBORw0KGgo=" alt="png">
    <p>${LONG}</p>`;
  const { content } = extract(page(inner), PAGE_URL, { imageUrl });

  assert.doesNotMatch(content, /svg\+xml|text\/html/);
  assert.match(content, /data:image\/png/);
});

test("sanitizes the raw fallback too", () => {
  const html = `<html><head><title>X</title><meta http-equiv="refresh" content="0;url=https://evil.example"></head><body>
    <a href="javascript:alert(1)" onclick="x()">Sign in</a><form action="/p"><input name="q"></form>
    <img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="></body></html>`;
  const result = extract(html, PAGE_URL, { imageUrl });

  assert.equal(result.raw, true);
  assert.match(result.content, /Sign in/);
  assert.doesNotMatch(result.content, /javascript:|onclick|<form|<input|<meta|svg\+xml/i);
});

test("applies the link allow-list to image map areas too", () => {
  const inner = `<img usemap="#m" src="data:image/png;base64,iVBORw0KGgo=" alt="map">
    <map name="m"><area href="javascript:alert(1)" shape="rect" coords="0,0,9,9"><area href="https://example.org/ok" shape="rect" coords="0,0,9,9"></map>
    <p>${LONG}</p>`;
  const { content } = extract(page(inner), PAGE_URL, { imageUrl });

  assert.doesNotMatch(content, /javascript:/i);
  assert.match(content, /href="https:\/\/example\.org\/ok"/);
});
