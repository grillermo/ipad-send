import { test } from "node:test";
import assert from "node:assert/strict";
import { extractMarkdown } from "../src/extract.js";
import { markdownToHtml } from "../src/markdown.js";

const PAGE_URL = "https://raw.githubusercontent.com/acme/docs/main/guide/Strategy.md?token=abc";
const imageUrl = (src) => `/img?u=${encodeURIComponent(src)}`;
const MARKDOWN = [
  "# Overall Strategy", //   1
  "", //                     2
  "First paragraph about **goals**.", // 3
  "", //                     4
  "## Second section", //    5
  "", //                     6
  "- one", //                7
  "- two", //                8
  "", //                     9
  "Closing words with ![chart](img/chart.png) and [a link](other.md).", // 10
  "", //                     11
  "<script>alert(1)</script>", // 12
].join("\n");

const render = async (line = 0) => extractMarkdown(await markdownToHtml(MARKDOWN), PAGE_URL, { imageUrl, line });

test("renders markdown to clean html titled by its first heading", async () => {
  const result = await render();

  assert.equal(result.title, "Overall Strategy");
  assert.equal(result.raw, false);
  assert.match(result.content, /<h2[^>]*>Second section<\/h2>/);
  assert.match(result.content, /<strong>goals<\/strong>/);
  assert.match(result.content, /<li>one<\/li>/);
  assert.doesNotMatch(result.content, /data-pos|data-wrapper|<script|ipad-send-continue/);
});

test("resolves relative images and links against the markdown file's url", async () => {
  const { content } = await render();

  assert.ok(content.includes(imageUrl("https://raw.githubusercontent.com/acme/docs/main/guide/img/chart.png")));
  assert.match(content, /href="https:\/\/raw\.githubusercontent\.com\/acme\/docs\/main\/guide\/other\.md"/);
});

test("anchors at the source line that was at the top of Chrome's window", async () => {
  assert.match((await render(5)).content, /<span id="ipad-send-continue"><\/span><h2[^>]*>Second section/);
  assert.match((await render(8)).content, /<li><span id="ipad-send-continue"><\/span>two<\/li>/);
  assert.match((await render(9)).content, /<span id="ipad-send-continue"><\/span>two/, "blank line keeps the block above");
});

test("falls back to the file name when there is no h1", async () => {
  const result = extractMarkdown(await markdownToHtml("Just text."), PAGE_URL, { imageUrl, line: 0 });

  assert.equal(result.title, "Strategy.md");
});
