import type {DatabaseSync} from 'node:sqlite';
import {transaction} from './db.ts';
import {conflict, invalid, notFound, preconditionFailed, preconditionRequired} from './errors.ts';

export const statuses = ['Open', 'Assigned', 'In progress', 'Completed'] as const;
export type Status = (typeof statuses)[number];
export const teams = ['Facilities', 'IT', 'People', 'Operations'] as const;
export const transitions: Record<Status, readonly Status[]> = {
  Open: ['Assigned'], Assigned: ['Open', 'In progress'], 'In progress': ['Assigned', 'Completed'], Completed: ['Open']
};

export interface RequestRow {
  id: number; title: string; requester: string; team: string; description: string;
  status: Status; created_at: string; updated_at: string; revision: number;
}
export interface HistoryRow {event: string; previous_status: Status | null; status: Status; at: string}
export type RequestDetail = RequestRow & {history: HistoryRow[]; next: readonly Status[]};
export type RequestSummary = Pick<RequestRow, 'id' | 'title' | 'requester' | 'team' | 'status' | 'updated_at'>;
export interface Store {
  list(filter?: {status?: string; q?: string}): RequestSummary[];
  get(id: number): RequestDetail;
  add(body: Record<string, unknown>): RequestDetail;
  update(id: number, status: unknown, revision: number): RequestDetail;
}

function clean(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw invalid(label + ' must be 1–' + max + ' characters.');
  return value.trim();
}

export function createStore(db: DatabaseSync): Store {
  const insert = db.prepare('INSERT INTO requests(id,title,requester,team,description,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)');
  const log = db.prepare('INSERT INTO activity(request_id,event,previous_status,status,at) VALUES(?,?,?,?,?)');
  const byId = db.prepare('SELECT * FROM requests WHERE id=?');
  const history = db.prepare('SELECT event,previous_status,status,at FROM activity WHERE request_id=? ORDER BY id');
  function get(id: number): RequestDetail {
    const item = byId.get(id) as RequestRow | undefined;
    if (!item) throw notFound('Request not found.');
    return {...item, history: history.all(id) as unknown as HistoryRow[], next: transitions[item.status]};
  }
  return {
    list({status = '', q = ''} = {}) {
      if (status && !(statuses as readonly string[]).includes(status)) throw invalid('Unknown status.');
      if (q.length > 100) throw invalid('Search must be 100 characters or fewer.');
      return db.prepare(`SELECT id,title,requester,team,status,updated_at FROM requests
       WHERE (?='' OR status=?) AND (?='' OR instr(lower(title||' '||requester||' '||team||' SR-'||id),lower(?))>0)
       ORDER BY updated_at DESC,id DESC`).all(status, status, q, q) as unknown as RequestSummary[];
    },
    get,
    add(body) {
      const title = clean(body.title, 'Title', 100), requester = clean(body.requester, 'Requester', 70),
        team = clean(body.team, 'Team', 30), description = clean(body.description, 'Description', 1000);
      if (!(teams as readonly string[]).includes(team)) throw invalid('Select a valid team.');
      return transaction(db, () => {
        const {id} = db.prepare('SELECT max(coalesce((SELECT max(id) FROM requests),1039),1039)+1 AS id').get() as {id: number};
        const now = new Date().toISOString();
        insert.run(id, title, requester, team, description, 'Open', now, now);
        log.run(id, 'Request opened', null, 'Open', now);
        return get(id);
      });
    },
    update(id, status, revision) {
      if (!Number.isSafeInteger(revision) || revision < 1) throw preconditionRequired('A request revision is required.');
      if (typeof status !== 'string' || !(statuses as readonly string[]).includes(status)) throw invalid('Select a valid status.');
      const next = status as Status;
      return transaction(db, () => {
        const item = get(id);
        if (item.revision !== revision) throw preconditionFailed('Someone updated this request. Review the latest version before trying again.');
        if (!item.next.includes(next)) throw conflict('That status change is not available. Refresh the request and try again.');
        const now = new Date().toISOString();
        db.prepare('UPDATE requests SET status=?,updated_at=?,revision=revision+1 WHERE id=? AND revision=?').run(next, now, id, revision);
        log.run(id, 'Status changed', item.status, next, now);
        return get(id);
      });
    }
  };
}
