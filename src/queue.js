import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const emptyState = () => ({ version: 0, current: null, pending: [], read: [], docs: {} });

export class Queue extends EventEmitter {
  #stateFile;
  #docsDir;
  #readLimit;
  #state;

  constructor(dataDir, { readLimit = 50 } = {}) {
    super();
    this.setMaxListeners(0); // one listener per open long-poll
    this.#stateFile = path.join(dataDir, "queue.json");
    this.#docsDir = path.join(dataDir, "docs");
    this.#readLimit = readLimit;
    fs.mkdirSync(this.#docsDir, { recursive: true });
    this.#state = this.#load();
  }

  get version() {
    return this.#state.version;
  }

  push({ title, byline, url, raw, content }) {
    const id = randomUUID();
    fs.writeFileSync(this.#docPath(id), content);
    const doc = { id, title, byline, url, raw, createdAt: new Date().toISOString() };
    this.#state.docs[id] = doc;
    if (this.#state.current) this.#state.pending.push(id);
    else this.#state.current = id;
    this.#changed();
    return doc;
  }

  advance(from) {
    const state = this.#state;
    if (!state.current || state.current !== from) return false;

    state.read.push(state.current);
    state.current = state.pending.shift() ?? null;
    for (const id of state.read.splice(0, Math.max(0, state.read.length - this.#readLimit))) {
      delete state.docs[id];
      fs.rmSync(this.#docPath(id), { force: true });
    }
    this.#changed();
    return true;
  }

  snapshot() {
    const { version, current, pending, docs } = this.#state;
    return { version, current: current ? docs[current] : null, queued: pending.length };
  }

  content(id) {
    return Object.hasOwn(this.#state.docs, id) ? fs.readFileSync(this.#docPath(id), "utf8") : null;
  }

  waitForChange(since, timeoutMs) {
    return new Promise((resolve) => {
      if (this.version !== since) return resolve(this.version);
      const done = () => {
        clearTimeout(timer);
        this.off("change", done);
        resolve(this.version);
      };
      const timer = setTimeout(done, timeoutMs);
      this.on("change", done);
    });
  }

  #load() {
    try {
      return JSON.parse(fs.readFileSync(this.#stateFile, "utf8"));
    } catch {
      return emptyState();
    }
  }

  #changed() {
    this.#state.version += 1;
    const tmp = `${this.#stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.#state));
    fs.renameSync(tmp, this.#stateFile); // atomic: a crash never leaves half a JSON file
    this.emit("change", this.#state.version);
  }

  #docPath(id) {
    return path.join(this.#docsDir, `${id}.html`);
  }
}
