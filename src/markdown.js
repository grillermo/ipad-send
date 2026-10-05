import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PANDOC = process.env.PANDOC || "pandoc";
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

// sourcepos tags each element with data-pos="line:col-line:col" so extractMarkdown can find the line the
// reader was on in Chrome. Highlighting is off: it adds per-line links and markup the iPad doesn't need.
export async function markdownToHtml(markdown) {
  const run = execFileAsync(PANDOC, ["-f", "gfm+sourcepos", "-t", "html5", "--syntax-highlighting=none"], {
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  run.child.stdin.end(markdown);
  const { stdout } = await run;
  return stdout;
}
