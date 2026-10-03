import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

export const MAX_WIDTH = 1024;
// iOS 5 refuses to decode very large images; cap height too for tall infographics.
const MAX_HEIGHT = 3000;
const FETCH_TIMEOUT_MS = 15_000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

export const PLACEHOLDER_GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

export function proxiedImageUrl(src, referer) {
  const params = new URLSearchParams({ u: src });
  if (referer) params.set("r", referer);
  return `/img?${params}`;
}

export function createImageProxy({ cacheDir, fetchImpl = fetch }) {
  const inFlight = new Map();

  async function load(url, referer) {
    const file = path.join(cacheDir, `${createHash("sha1").update(url).digest("hex")}.jpg`);
    try {
      return await fs.readFile(file);
    } catch {
      // not cached yet
    }

    const headers = { "User-Agent": USER_AGENT };
    if (referer) headers.Referer = referer;
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`upstream ${response.status} for ${url}`);

    const output = await sharp(Buffer.from(await response.arrayBuffer()))
      .rotate()
      .resize({ width: MAX_WIDTH, height: MAX_HEIGHT, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 70 })
      .toBuffer();

    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(file, output);
    return output;
  }

  // An article may reference the same image twice; fetch it once.
  return function getImage(url, referer) {
    if (!inFlight.has(url)) inFlight.set(url, load(url, referer).finally(() => inFlight.delete(url)));
    return inFlight.get(url);
  };
}
