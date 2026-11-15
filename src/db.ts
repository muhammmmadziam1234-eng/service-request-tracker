import {DatabaseSync} from 'node:sqlite';
import {migrate} from './migrate.ts';

/** Opens (creating if needed) the database, applies pending migrations and returns the handle. */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;');
  try { migrate(db); } catch (error) { db.close(); throw error; }
  return db;
}

/** Runs fn inside one IMMEDIATE transaction: all of its writes commit together or not at all. */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) return fn(); // already inside one (the seed groups several store calls): join it
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* SQLite already rolled back */ }
    throw error;
  }
}
