import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

export const migrationsDir = fileURLToPath(new URL('./migrations/', import.meta.url));

/** Reads NNN_name.sql files. Numbers must run 001, 002, ... with no gaps, so the order is unambiguous. */
export function loadMigrations(dir = migrationsDir) {
  const files = readdirSync(dir).filter(file => file.endsWith('.sql')).sort();
  return files.map((file, index) => {
    const match = /^(\d{3})_[a-z0-9_]+\.sql$/.exec(file);
    if (!match) throw new Error('Migration files are named NNN_name.sql, got ' + file);
    if (Number(match[1]) !== index + 1) throw new Error('Migrations must be numbered 001, 002, ... without gaps; found ' + file + ' at position ' + (index + 1));
    return {version: index + 1, file, sql: readFileSync(join(dir, file), 'utf8')};
  });
}

export const schemaVersion = db => db.prepare('PRAGMA user_version').get().user_version;

function rollback(db) {
  try { db.exec('ROLLBACK'); } catch { /* already rolled back by SQLite */ }
}

/** The version-1 program added the revision column after the fact; do the same for even older files. */
function repairUnversioned(db) {
  const columns = db.prepare('PRAGMA table_info(requests)').all();
  if (columns.length && !columns.some(column => column.name === 'revision'))
    db.exec('ALTER TABLE requests ADD COLUMN revision INTEGER NOT NULL DEFAULT 1');
}

/**
 * Applies pending migrations, each in its own IMMEDIATE transaction together with the user_version bump.
 * The version is read again inside the transaction, so two processes starting together apply each migration once.
 */
export function migrate(db, {dir = migrationsDir, upTo = Infinity} = {}) {
  const migrations = loadMigrations(dir), from = schemaVersion(db), applied = [];
  if (from > migrations.length)
    throw new Error(`The database is at schema version ${from}, which is newer than this program understands (${migrations.length}). It was not changed.`);
  for (const migration of migrations) {
    if (migration.version > upTo) break;
    db.exec('BEGIN IMMEDIATE');
    try {
      if (schemaVersion(db) >= migration.version) { rollback(db); continue; }
      if (migration.version === 1) repairUnversioned(db);
      db.exec(migration.sql);
      db.exec('PRAGMA user_version = ' + migration.version);
      db.exec('COMMIT');
      applied.push(migration.version);
    } catch (error) {
      rollback(db);
      throw new Error(`Migration ${migration.file} failed and was rolled back: ${error.message}`, {cause: error});
    }
  }
  return {from, to: schemaVersion(db), applied};
}
