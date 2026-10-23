import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const migration = new URL("../../migrations/001-number-crunch.sql", import.meta.url);

export async function applyMigration(db) {
  await db.exec(await readFile(migration, "utf8"));
}

export async function freshDb() {
  const db = new PGlite();
  await db.exec("CREATE ROLE number_crunch_owner; GRANT ALL ON SCHEMA public TO number_crunch_owner");
  await applyMigration(db);
  return db;
}
