import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { applyLegacyImport } from "../server/legacy-import.mjs";

if (!process.env.MIGRATION_DATABASE_URL) throw new Error("MIGRATION_DATABASE_URL is required; do not use the application runtime credential");
const dir = process.argv[2];
if (!dir) throw new Error("Usage: node scripts/import-firebase.mjs <snapshotDir>");
const read = async (name) => JSON.parse(await readFile(join(dir, name), "utf8"));
const client = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL, connectionTimeoutMillis: 5000 });
try {
  const data = { leaderboard: await read("leaderboard.json"), records: await read("records.json"), users: await read("users.json"), emails: await read("legacy-emails.json"), now: Date.now() };
  await client.connect();
  await client.query("SET ROLE number_crunch_owner");
  const counts = await applyLegacyImport(client, data);
  console.log(`Imported ${counts.players} players, ${counts.bestTimes} best times, ${counts.claims} email claims`);
} catch {
  console.error("Firebase import failed; check the snapshot directory, target database and migration-role access");
  process.exitCode = 1;
} finally {
  await client.end();
}
