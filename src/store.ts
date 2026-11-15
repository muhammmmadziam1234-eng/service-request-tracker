import {DatabaseSync} from 'node:sqlite';
import {migrate} from './migrate.ts';

export const statuses = ['Open', 'Assigned', 'In progress', 'Completed'] as const;
export type Status = (typeof statuses)[number];
export const teams = ['Facilities', 'IT', 'People', 'Operations'] as const;
export const transitions: Record<Status, readonly Status[]> = {
  Open: ['Assigned'], Assigned: ['Open', 'In progress'], 'In progress': ['Assigned', 'Completed'], Completed: ['Open']
};

export class InputError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

export interface RequestRow {
  id: number; title: string; requester: string; team: string; description: string;
  status: Status; created_at: string; updated_at: string; revision: number;
}
export interface HistoryRow {event: string; previous_status: Status | null; status: Status; at: string}
export type RequestDetail = RequestRow & {history: HistoryRow[]; next: readonly Status[]};
export type RequestSummary = Pick<RequestRow, 'id' | 'title' | 'requester' | 'team' | 'status' | 'updated_at'>;
export interface Store {
  close(): void;
  list(filter?: {status?: string; q?: string}): RequestSummary[];
  get(id: number): RequestDetail;
  add(body: Record<string, unknown>): RequestDetail;
  update(id: number, status: unknown, revision: number): RequestDetail;
}

function clean(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new InputError(label + ' must be 1–' + max + ' characters.');
  return value.trim();
}
const seed: [number, string, string, string, string, Status][] = [
  [1040, 'Set up a laptop for new starter', 'Avery Cole', 'IT', 'Prepare a laptop and standard software before the start date.', 'Completed'],
  [1041, 'Request access to the CRM', 'Noah Parker', 'Operations', 'Set up access for a new account coordinator.', 'Open'],
  [1042, 'Replace access badge', 'Taylor Reed', 'Facilities', 'The current access badge is unreliable at the east entrance. Please issue a replacement.', 'In progress'],
  [1043, 'Prepare a desk in Studio B', 'Riley Chen', 'Facilities', 'Set up a monitor, chair, and power supply at desk B12.', 'Assigned'],
  [1044, 'Update new starter checklist', 'Morgan Ellis', 'People', 'Add the equipment return and badge handover steps.', 'Open']
];

export function openStore(path: string, {seedData = true}: {seedData?: boolean} = {}): Store {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;');
  migrate(db);
  const insert = db.prepare('INSERT INTO requests(id,title,requester,team,description,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)');
  const log = db.prepare('INSERT INTO activity(request_id,event,previous_status,status,at) VALUES(?,?,?,?,?)');
  function tx<T>(fn: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  if (seedData) {
    tx(() => {
      if (db.prepare("SELECT key FROM metadata WHERE key='seed-v1'").get()) return;
      for (const [id, title, requester, team, description, status] of seed) {
        const progression = statuses.slice(0, statuses.indexOf(status) + 1);
        const time = (i: number) => '2026-06-0' + (id - 1038) + 'T09:' + String(i * 10).padStart(2, '0') + ':00.000Z';
        insert.run(id, title, requester, team, description, status, time(0), time(progression.length - 1));
        progression.forEach((step, i) => log.run(id, i ? 'Status changed' : 'Request opened', progression[i - 1] ?? null, step, time(i)));
      }
      db.prepare("INSERT INTO metadata VALUES('seed-v1')").run();
    });
  }
  const byId = db.prepare('SELECT * FROM requests WHERE id=?');
  const history = db.prepare('SELECT event,previous_status,status,at FROM activity WHERE request_id=? ORDER BY id');
  function get(id: number): RequestDetail {
    const item = byId.get(id) as RequestRow | undefined;
    if (!item) throw new InputError('Request not found.', 404);
    return {...item, history: history.all(id) as unknown as HistoryRow[], next: transitions[item.status]};
  }
  return {
    close: () => db.close(),
    list({status = '', q = ''} = {}) {
      if (status && !(statuses as readonly string[]).includes(status)) throw new InputError('Unknown status.');
      if (q.length > 100) throw new InputError('Search must be 100 characters or fewer.');
      return db.prepare(`SELECT id,title,requester,team,status,updated_at FROM requests
       WHERE (?='' OR status=?) AND (?='' OR instr(lower(title||' '||requester||' '||team||' SR-'||id),lower(?))>0)
       ORDER BY updated_at DESC,id DESC`).all(status, status, q, q) as unknown as RequestSummary[];
    },
    get,
    add(body) {
      const title = clean(body.title, 'Title', 100), requester = clean(body.requester, 'Requester', 70),
        team = clean(body.team, 'Team', 30), description = clean(body.description, 'Description', 1000);
      if (!(teams as readonly string[]).includes(team)) throw new InputError('Select a valid team.');
      return tx(() => {
        const {id} = db.prepare('SELECT max(coalesce((SELECT max(id) FROM requests),1039),1039)+1 AS id').get() as {id: number};
        const now = new Date().toISOString();
        insert.run(id, title, requester, team, description, 'Open', now, now);
        log.run(id, 'Request opened', null, 'Open', now);
        return get(id);
      });
    },
    update(id, status, revision) {
      if (!Number.isSafeInteger(revision) || revision < 1) throw new InputError('A request revision is required.', 428);
      if (typeof status !== 'string' || !(statuses as readonly string[]).includes(status)) throw new InputError('Select a valid status.');
      const next = status as Status;
      return tx(() => {
        const item = get(id);
        if (item.revision !== revision) throw new InputError('Someone updated this request. Review the latest version before trying again.', 412);
        if (!item.next.includes(next)) throw new InputError('That status change is not available. Refresh the request and try again.', 409);
        const now = new Date().toISOString();
        db.prepare('UPDATE requests SET status=?,updated_at=?,revision=revision+1 WHERE id=? AND revision=?').run(next, now, id, revision);
        log.run(id, 'Status changed', item.status, next, now);
        return get(id);
      });
    }
  };
}
