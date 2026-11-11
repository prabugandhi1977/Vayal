// Tiny JSON-file store. Fine for a team of a few hundred people; swap in your own
// object with the same shape (init/data/save/savePhoto/readPhoto) for a database.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const EMPTY = () => ({ employees: [], offices: [], records: [], live: {}, challenges: {} });

export class FileStore {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, "attendance.json");
    this.photoDir = path.join(dir, "photos");
    this.data = EMPTY();
    this._queue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(this.photoDir, { recursive: true });
    try {
      this.data = { ...EMPTY(), ...JSON.parse(await fs.readFile(this.file, "utf8")) };
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    return this;
  }

  /** Writes are serialised and atomic (temp file + rename). */
  save() {
    this._queue = this._queue.then(async () => {
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(this.data), { mode: 0o600 });
      await fs.rename(tmp, this.file);
    });
    return this._queue;
  }

  async savePhoto(id, buf) {
    await fs.writeFile(path.join(this.photoDir, `${id}.jpg`), buf, { mode: 0o600 });
  }
  async readPhoto(id) {
    if (!/^[\w-]+$/.test(id)) return null;
    try { return await fs.readFile(path.join(this.photoDir, `${id}.jpg`)); } catch { return null; }
  }

  /** A secret that survives restarts when ATTENDANCE_SECRET is not set. */
  async persistentSecret() {
    const f = path.join(this.dir, "secret.key");
    try { return (await fs.readFile(f, "utf8")).trim(); } catch { /* create below */ }
    const s = crypto.randomBytes(32).toString("hex");
    await fs.writeFile(f, s, { mode: 0o600 });
    return s;
  }
}
