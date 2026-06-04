// SQLite persistence layer (built-in node:sqlite — zero dependencies).
//
// The rest of the app keeps working on a plain in-memory `data` object exactly
// as before; only loading/saving is backed by SQLite here. Each collection is a
// document table (one JSON doc per row, preserved order); the four singletons
// live in a key/value table. persistData() writes inside a single transaction
// and skips collections that did not change since load (snapshot diff), so a
// small edit does not rewrite large tables (e.g. steamDailyMetrics).

import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";

const COLLECTIONS = [
  "games",
  "storeListings",
  "campaigns",
  "creatorProfiles",
  "creators",
  "influencerKeys",
  "emailTemplates",
  "steamDailyMetrics",
  "outreachLogs",
  "syncRuns",
  "youtubeChannels",
  "youtubeSnapshots",
  "redditPosts",
];

const SINGLETONS = ["meta", "steamSyncState", "integrationSettings", "syncSchedule"];

let db = null;

export function initDb(file) {
  mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  // Default rollback journal (DELETE) is used for broad compatibility with
  // bind-mounted volumes (incl. Docker Desktop on Windows), where WAL shared
  // memory can misbehave. Access here is single-threaded & synchronous, so WAL
  // brings no benefit anyway.
  for (const name of COLLECTIONS) {
    db.exec(`CREATE TABLE IF NOT EXISTS ${name} (seq INTEGER PRIMARY KEY AUTOINCREMENT, doc TEXT NOT NULL)`);
  }
  db.exec("CREATE TABLE IF NOT EXISTS singletons (key TEXT PRIMARY KEY, doc TEXT NOT NULL)");
  return db;
}

export function dbIsEmpty() {
  for (const name of COLLECTIONS) {
    if (db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get().n > 0) return false;
  }
  return db.prepare("SELECT COUNT(*) AS n FROM singletons").get().n === 0;
}

export function loadData() {
  const data = {};
  const snapshots = {};
  for (const name of COLLECTIONS) {
    const rows = db.prepare(`SELECT doc FROM ${name} ORDER BY seq ASC`).all();
    data[name] = rows.map((row) => JSON.parse(row.doc));
    snapshots[name] = JSON.stringify(data[name]);
  }
  const singletonRows = db.prepare("SELECT key, doc FROM singletons").all();
  const singletonMap = new Map(singletonRows.map((row) => [row.key, row.doc]));
  for (const key of SINGLETONS) {
    const raw = singletonMap.get(key);
    data[key] = raw ? JSON.parse(raw) : {};
    snapshots[key] = raw || "";
  }
  Object.defineProperty(data, "__snapshots", { value: snapshots, enumerable: false, configurable: true });
  return data;
}

export function persistData(data) {
  if (!db) throw new Error("db not initialised");
  const snapshots = data.__snapshots || {};
  db.exec("BEGIN");
  try {
    for (const name of COLLECTIONS) {
      const arr = Array.isArray(data[name]) ? data[name] : [];
      const current = JSON.stringify(arr);
      if (current === snapshots[name]) continue; // unchanged → skip rewrite
      db.prepare(`DELETE FROM ${name}`).run();
      const insert = db.prepare(`INSERT INTO ${name} (doc) VALUES (?)`);
      for (const item of arr) insert.run(JSON.stringify(item));
    }
    const upsert = db.prepare(
      "INSERT INTO singletons (key, doc) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET doc = excluded.doc",
    );
    for (const key of SINGLETONS) {
      const current = JSON.stringify(data[key] ?? {});
      if (current === snapshots[key]) continue;
      upsert.run(key, current);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

// One-time import of a legacy JSON data file (or a seeded default object) into an
// empty database. Returns true if a migration/seed was performed.
export function migrateFromJson(jsonPath, seedFactory) {
  if (!dbIsEmpty()) return false;
  let seed;
  if (jsonPath && existsSync(jsonPath)) {
    try {
      seed = JSON.parse(readFileSync(jsonPath, "utf8"));
    } catch {
      seed = seedFactory();
    }
  } else {
    seed = seedFactory();
  }
  persistData(seed); // seed has no __snapshots → every collection/singleton is written
  return true;
}
