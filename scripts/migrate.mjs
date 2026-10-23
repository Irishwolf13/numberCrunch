import { readdir, readFile } from "node:fs/promises";
import pg from "pg";

if (!process.env.MIGRATION_DATABASE_URL) throw new Error("MIGRATION_DATABASE_URL is required; do not use the application runtime credential");
const dir = new URL("../migrations/", import.meta.url);
const client = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL, connectionTimeoutMillis: 5000 });
try {
  await client.connect();
  for (const file of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) {
    await client.query(await readFile(new URL(file, dir), "utf8"));
  }
  console.log("Number Crunch migrations complete");
} catch {
  console.error("Number Crunch migrations failed; check the target database and migration-role access");
  process.exitCode = 1;
} finally {
  await client.end();
}
