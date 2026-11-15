import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openStore as openV1} from './fixtures/v1-store.mjs';
import {migrate, loadMigrations, schemaVersion} from '../src/migrate.ts';

const latest = loadMigrations().length;
const v1Tables = ['requests', 'activity', 'metadata'];
async function scratch(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'relay-migrate-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  return dir;
}
type Row = Record<string, any>;
const plain = (rows: Row[]): Row[] => rows.map(row => ({...row}));
// Everything observable in a database: schema text, user_version and every row of every table.
function dump(db: DatabaseSync) {
  const out: Row = {version: schemaVersion(db), schema: plain(db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name').all())};
  for (const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name: string}[])
    out[name] = plain(db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all());
  return out;
}
const shape = (db: DatabaseSync, table: string) => plain(db.prepare(`PRAGMA table_info(${table})`).all());

test('migration 001 is exactly the schema the version-1 code created', async t => {
  const dir = await scratch(t);
  openV1(join(dir, 'v1.sqlite'), {seedData: false}).close();
  const v1 = new DatabaseSync(join(dir, 'v1.sqlite')), fresh = new DatabaseSync(':memory:');
  t.after(() => { v1.close(); fresh.close(); });
  migrate(fresh, {upTo: 1});
  assert.equal(schemaVersion(fresh), 1);
  for (const table of v1Tables) assert.deepEqual(shape(fresh, table), shape(v1, table), table);
  assert.deepEqual(plain(fresh.prepare('PRAGMA index_list(activity)').all().filter(i => i.origin === 'c')),
    plain(v1.prepare('PRAGMA index_list(activity)').all().filter(i => i.origin === 'c')));
  for (const db of [v1, fresh])
    assert.throws(() => db.exec("INSERT INTO requests(id,title,requester,team,description,status,created_at,updated_at) VALUES(1,'a','b','c','d','Done','x','x')"), /CHECK/);
});

test('a version-1 database upgrades in place and keeps every row, revision and history entry', async t => {
  const dir = await scratch(t), path = join(dir, 'v1.sqlite');
  const store = openV1(path);                                      // v1 code: schema, five sample requests, history
  const {id} = store.add({title: 'Replace projector', requester: 'Casey Lee', team: 'IT', description: 'The HDMI port fails.'});
  store.update(id, 'Assigned', 1);
  store.update(id, 'In progress', 2);
  store.close();

  const db = new DatabaseSync(path);
  t.after(() => db.close());
  assert.equal(schemaVersion(db), 0, 'the old code never set user_version');
  const before = Object.fromEntries(v1Tables.map(table => [table, plain(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())]));
  assert.equal(before.requests!.length, 6);
  assert.equal(before.requests!.find(r => r.id === id)!.revision, 3);

  const first = migrate(db);
  assert.equal(first.from, 0);
  assert.equal(first.to, latest);
  assert.equal(schemaVersion(db), latest);
  for (const table of v1Tables) {
    const after = plain(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    assert.equal(after.length, before[table]!.length, table + ' row count');
    before[table]!.forEach((row, i) => { for (const key of Object.keys(row)) assert.deepEqual(after[i]![key], row[key], `${table}[${i}].${key}`); });
  }
  assert.equal(plain(db.prepare('SELECT * FROM activity WHERE request_id=? ORDER BY id').all(id)).length, 3);

  const snapshot = dump(db);
  const second = migrate(db);
  assert.deepEqual(second.applied, []);
  assert.deepEqual(dump(db), snapshot, 'running the migrations twice changes nothing');
  const reopened = new DatabaseSync(path);
  t.after(() => reopened.close());
  assert.equal(schemaVersion(reopened), latest);
});

test('a database from before the revision column existed gains it with the default', async t => {
  const dir = await scratch(t), db = new DatabaseSync(join(dir, 'v0.sqlite'));
  t.after(() => db.close());
  db.exec(`CREATE TABLE requests(id INTEGER PRIMARY KEY, title TEXT NOT NULL, requester TEXT NOT NULL, team TEXT NOT NULL,
    description TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('Open','Assigned','In progress','Completed')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE activity(id INTEGER PRIMARY KEY, request_id INTEGER NOT NULL REFERENCES requests(id), event TEXT NOT NULL, previous_status TEXT, status TEXT NOT NULL, at TEXT NOT NULL);
    CREATE INDEX activity_request ON activity(request_id,id); CREATE TABLE metadata (key TEXT PRIMARY KEY);
    INSERT INTO requests VALUES(7,'Old request','Pat','IT','Kept.','Open','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');`);
  migrate(db);
  assert.equal((db.prepare('SELECT revision FROM requests WHERE id=7').get() as {revision: number}).revision, 1);
});

test('a failing migration is rolled back completely and leaves the version untouched', async t => {
  const dir = await scratch(t), path = join(dir, 'mig');
  await mkdir(path);
  await writeFile(join(path, '001_first.sql'), 'CREATE TABLE first(x);');
  await writeFile(join(path, '002_broken.sql'), 'CREATE TABLE second(x); INSERT INTO missing_table VALUES(1);');
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  assert.throws(() => migrate(db, {dir: path}), /002_broken/);
  assert.equal(schemaVersion(db), 1);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r['name']);
  assert.deepEqual(tables, ['first']);
});

test('a database newer than the program is refused untouched, and numbering gaps are rejected', async t => {
  const dir = await scratch(t), path = join(dir, 'gap');
  await mkdir(path);
  await writeFile(join(path, '001_a.sql'), 'CREATE TABLE a(x);');
  await writeFile(join(path, '003_c.sql'), 'CREATE TABLE c(x);');
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  assert.throws(() => migrate(db, {dir: path}), /without gaps/);
  db.exec('PRAGMA user_version = 99');
  assert.throws(() => migrate(db), /newer than this program/);
  assert.equal(schemaVersion(db), 99);
  assert.equal((db.prepare('SELECT count(*) AS n FROM sqlite_master').get() as {n: number}).n, 0);
});
