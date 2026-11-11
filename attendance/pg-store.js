// Postgres store: keeps attendance data in a database so it survives restarts and redeploys.
// Works with any Postgres, including free hosted ones (Neon, Supabase). Set ATTENDANCE_DATABASE_URL.
// Same shape as FileStore. The whole data set is kept in memory and saved as one JSON row,
// which suits a team of a few hundred; photos go in their own table.
import crypto from "node:crypto";
import pg from "pg";
import { EMPTY } from "./store.js";

export class PgStore {
  kind = "postgres";
  /** @param {string} url  postgres:// connection string (include ?sslmode=require for hosted databases)
   *  @param {object} [pool] an existing pg-compatible pool (used by tests) */
  constructor(url, pool) {
    if (!pool) {
      // Be forgiving about how the address was pasted (quotes, spaces, or Neon's "psql '...'" snippet), strict about the rest.
      const m = /postgres(?:ql)?:\/\/[^\s'"]+/.exec(String(url || ""));
      if (!m) throw Object.assign(new Error("Invalid URL"), { code: "ERR_INVALID_URL" });
      url = m[0];
    }
    this.pool = pool || new pg.Pool({ connectionString: url, max: 3, connectionTimeoutMillis: 15000 });
    this.data = EMPTY();
    this._queue = Promise.resolve();
  }

  async init() {
    await this.pool.query("CREATE TABLE IF NOT EXISTS att_kv (key text, value jsonb)");
    await this.pool.query("CREATE UNIQUE INDEX IF NOT EXISTS att_kv_key ON att_kv (key)");
    await this.pool.query("CREATE TABLE IF NOT EXISTS att_photos (id text, jpg bytea)");
    await this.pool.query("CREATE UNIQUE INDEX IF NOT EXISTS att_photos_id ON att_photos (id)");
    const { rows } = await this.pool.query("SELECT value FROM att_kv WHERE key = 'data'");
    if (rows[0]) this.data = { ...EMPTY(), ...rows[0].value };
    return this;
  }

  /** Writes are serialised so an older snapshot never overwrites a newer one. */
  save() {
    this._queue = this._queue.then(() =>
      this.pool.query("INSERT INTO att_kv (key, value) VALUES ('data', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [JSON.stringify(this.data)]));
    return this._queue;
  }

  async savePhoto(id, buf) {
    await this.pool.query("INSERT INTO att_photos (id, jpg) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET jpg = EXCLUDED.jpg", [id, buf]);
  }
  async readPhoto(id) {
    if (!/^[\w-]+$/.test(id)) return null;
    const { rows } = await this.pool.query("SELECT jpg FROM att_photos WHERE id = $1", [id]);
    return rows[0]?.jpg || null;
  }

  async persistentSecret() {
    await this.pool.query("INSERT INTO att_kv (key, value) VALUES ('secret', $1) ON CONFLICT (key) DO NOTHING", [JSON.stringify(crypto.randomBytes(32).toString("hex"))]);
    const { rows } = await this.pool.query("SELECT value FROM att_kv WHERE key = 'secret'");
    return rows[0].value;
  }
}
