import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const emptyState = () => ({ version: 0, current: null, ids: [], docs: {} });

// Oldest first. The newest send is always shown; previous/next walk back and forth.
export class History extends EventEmitter {
  #stateFile;
  #legacyFile;
  #docsDir;
  #limit;
  #state;

  constructor(dataDir, { limit = 50 } = {}) {
    super();
    this.setMaxListeners(0); // one listener per open long-poll
    this.#stateFile = path.join(dataDir, "history.json");
    this.#legacyFile = path.join(dataDir, "queue.json");
    this.#docsDir = path.join(dataDir, "docs");
    this.#limit = limit;
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
    const state = this.#state;
    state.docs[id] = doc;
    state.ids.push(id);
    state.current = id;
    for (const old of state.ids.splice(0, Math.max(0, state.ids.length - this.#limit))) {
      delete state.docs[old];
      fs.rmSync(this.#docPath(old), { force: true });
    }
    this.#changed();
    return doc;
  }

  // `from` guards against stale taps: only move if the reader is still on that document.
  go(from, step) {
    const state = this.#state;
    if (!state.current || state.current !== from || Math.abs(step) !== 1) return false;

    const target = state.ids[state.ids.indexOf(state.current) + step];
    if (!target) return false;
    state.current = target;
    this.#changed();
    return true;
  }

  snapshot() {
    const { version, current, ids, docs } = this.#state;
    const index = ids.indexOf(current);
    return {
      version,
      current: current ? docs[current] : null,
      hasPrevious: index > 0,
      hasNext: index !== -1 && index < ids.length - 1,
    };
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
      return this.#loadLegacy();
    }
  }

  // Before history there was a reading queue: read → current → pending.
  #loadLegacy() {
    try {
      const { version, current, pending, read, docs } = JSON.parse(fs.readFileSync(this.#legacyFile, "utf8"));
      const ids = [...read, current, ...pending].filter(Boolean);
      return { version, current: current ?? ids.at(-1) ?? null, ids, docs };
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
