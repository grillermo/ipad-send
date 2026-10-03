import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createImageProxy, proxiedImageUrl, MAX_WIDTH } from "../src/images.js";

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "ipad-send-img-"));
const bigPng = () =>
  sharp({ create: { width: 3000, height: 2000, channels: 3, background: "#336699" } }).png().toBuffer();

function fakeFetch(body, status = 200) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return new Response(body, { status });
  };
  return { fetchImpl, calls };
}

test("proxiedImageUrl encodes the image and referer so any upstream URL survives the query string", () => {
  const url = proxiedImageUrl("https://cdn.example.com/a b.png?x=1&y=2", "https://example.com/post");
  const params = new URL(url, "http://ipad").searchParams;

  assert.ok(url.startsWith("/img?"));
  assert.equal(params.get("u"), "https://cdn.example.com/a b.png?x=1&y=2");
  assert.equal(params.get("r"), "https://example.com/post");
});

test("downscales big images to a JPEG the iPad's 256MB of RAM can handle", async () => {
  const { fetchImpl } = fakeFetch(await bigPng());
  const getImage = createImageProxy({ cacheDir: tmpDir(), fetchImpl });

  const output = await getImage("https://cdn.example.com/big.png", "https://example.com/post");
  const meta = await sharp(output).metadata();

  assert.equal(meta.format, "jpeg");
  assert.equal(meta.width, MAX_WIDTH);
});

test("sends the page as Referer, because many CDNs block hotlinked images without it", async () => {
  const { fetchImpl, calls } = fakeFetch(await bigPng());
  const getImage = createImageProxy({ cacheDir: tmpDir(), fetchImpl });

  await getImage("https://cdn.example.com/big.png", "https://example.com/post");

  assert.equal(calls[0].options.headers.Referer, "https://example.com/post");
});

test("serves repeats from the disk cache, even after a restart, so re-reading is instant", async () => {
  const cacheDir = tmpDir();
  const { fetchImpl, calls } = fakeFetch(await bigPng());

  await createImageProxy({ cacheDir, fetchImpl })("https://cdn.example.com/big.png");
  await createImageProxy({ cacheDir, fetchImpl })("https://cdn.example.com/big.png");

  assert.equal(calls.length, 1);
});

test("rejects when upstream fails so the route can serve a placeholder", async () => {
  const { fetchImpl } = fakeFetch("nope", 404);
  const getImage = createImageProxy({ cacheDir: tmpDir(), fetchImpl });

  await assert.rejects(getImage("https://cdn.example.com/missing.png"), /upstream 404/);
});
