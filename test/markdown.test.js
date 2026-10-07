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

const renderText = async (markdown) =>
  (extractMarkdown(await markdownToHtml(markdown), PAGE_URL, { imageUrl, line: 0 })).content;

test("wraps markdown in .md and drops the leading h1 the reader already shows as the title", async () => {
  const content = await renderText("# Title\n\nBody.\n\n# Part two\n");

  assert.match(content, /^<div class="md">[\s\S]*<\/div>$/);
  assert.doesNotMatch(content, />Title</);
  assert.match(content, /<h1[^>]*>Part\stwo<\/h1>/);
});

test("drops the leading h1 even when the reader was at the top and the anchor sits before it", async () => {
  const { content } = extractMarkdown(await markdownToHtml("# Title\n\nBody.\n"), PAGE_URL, { imageUrl, line: 1 });

  assert.doesNotMatch(content, />Title</);
  assert.match(content, /id="ipad-send-continue"/);
});

test("turns GitHub alerts and **Note:** paragraphs into styled callouts", async () => {
  const content = await renderText(
    "> [!TIP]\n> Native.\n\n**Warning:** loose.\n\n> **Note**: quoted\n> more\n\n**Bold** but no colon.\n",
  );

  assert.match(content, /<div class="tip callout">\s*<div class="title">\s*<p>Tip<\/p>/);
  assert.match(content, /<div class="callout warning"><div class="title"><p>Warning<\/p><\/div><p>\s*loose\.<\/p><\/div>/);
  assert.match(content, /<div class="callout note"><div class="title"><p>Note<\/p><\/div>\s*<p>\s*quoted\s+more<\/p>/);
  assert.doesNotMatch(content, /<blockquote/);
  assert.match(content, /<p><strong>Bold<\/strong> but no colon\.<\/p>/);
});

test("draws task list checkboxes with css instead of glyphs iOS 5 lacks", async () => {
  const content = await renderText("- [ ] open\n- [x] closed\n");

  assert.match(content, /<li class="task-item"><span class="task"><\/span>open<\/li>/);
  assert.match(content, /<li class="task-item"><span class="task done"><\/span>closed<\/li>/);
  assert.doesNotMatch(content, /[☐☒]/);
});

test("loads images from /raw/ when the markdown came from a GitHub blob page", async () => {
  const blobUrl = "https://github.com/acme/docs/blob/main/guide/Strategy.md";
  const { content } = extractMarkdown(await markdownToHtml(MARKDOWN), blobUrl, { imageUrl, line: 0 });

  assert.ok(content.includes(imageUrl("https://github.com/acme/docs/raw/main/guide/img/chart.png")));
  assert.match(content, /href="https:\/\/github\.com\/acme\/docs\/blob\/main\/guide\/other\.md"/);
});
