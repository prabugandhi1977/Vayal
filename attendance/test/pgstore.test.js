import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { PgStore } from "../pg-store.js";

// PGlite is real Postgres (WebAssembly); this checks the SQL and the "survives a restart" behaviour.
test("Postgres store: data, photos and the signing secret survive a restart", async () => {
  const db = new PGlite();
  const pool = { query: (sql, params) => db.query(sql, params) }; // the store only needs pool.query
  const a = await new PgStore(null, pool).init();
  a.data.employees.push({ id: "e1", code: "E1", name: "Asha" });
  await a.save();
  await a.savePhoto("p1", Buffer.from([0xff, 0xd8, 1, 2, 3]));
  const secret = await a.persistentSecret();

  const b = await new PgStore(null, pool).init(); // "restart": a fresh store on the same database
  assert.equal(b.data.employees[0].name, "Asha");
  assert.deepEqual([...(await b.readPhoto("p1"))], [0xff, 0xd8, 1, 2, 3]);
  assert.equal(await b.persistentSecret(), secret);
  assert.equal(await b.readPhoto("../etc"), null);
  assert.equal(await b.readPhoto("missing"), null);

  b.data.employees.push({ id: "e2", code: "E2", name: "Ravi" });
  await b.save();
  assert.equal((await new PgStore(null, pool).init()).data.employees.length, 2); // later save replaces, not duplicates
});
