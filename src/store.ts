import type {DatabaseSync} from 'node:sqlite';
import {transaction} from './db.ts';
import {
  transitions, type HistoryKind, type Priority, type SortKey, type SortOrder, type Status, type Team
} from './domain.ts';
import {conflict, forbidden, invalid, notFound, preconditionFailed, preconditionRequired} from './errors.ts';
import {isStaff, type Role} from './policy.ts';
import type {PublicUser} from './users.ts';
import type {Changes, NewRequest} from './validate.ts';

export interface RequestSummary {
  id: number; title: string; requester: string; requester_id: number | null; team: Team; status: Status; priority: Priority;
  assignee: number | null; assignee_name: string | null; created_at: string; updated_at: string; revision: number;
}
export interface HistoryEntry {id: number; kind: HistoryKind; actor_id: number | null; actor_name: string | null; from: string | null; to: string | null; at: string}
export interface CommentEntry {id: number; author_id: number; author_name: string; author_role: Role; body: string; created_at: string}
export interface RequestDetail extends RequestSummary {description: string; next: readonly Status[]; history: HistoryEntry[]; comments: CommentEntry[]}
export interface ListQuery {
  status?: Status; priority?: Priority; assignee?: number | 'none'; q?: string;
  sort: SortKey; order: SortOrder; limit: number; offset: number;
}
export interface Page<T> {items: T[]; total: number; limit: number; offset: number}
export interface Store {
  list(actor: PublicUser, query: ListQuery): Page<RequestSummary>;
  get(actor: PublicUser, id: number): RequestDetail;
  create(actor: PublicUser, input: NewRequest): RequestDetail;
  /** `revision` is the If-Match value, or null when the client sent none. */
  update(actor: PublicUser, id: number, changes: Changes, revision: number | null): RequestDetail;
  addComment(actor: PublicUser, id: number, body: string): CommentEntry;
}

const SUMMARY = `r.id,r.title,r.requester,r.requester_id,r.team,r.status,r.priority,r.assignee_id AS assignee,
  a.display_name AS assignee_name,r.created_at,r.updated_at,r.revision`;
const FROM = 'requests r LEFT JOIN users a ON a.id=r.assignee_id';
const RANK = "CASE r.priority WHEN 'Urgent' THEN 4 WHEN 'High' THEN 3 WHEN 'Normal' THEN 2 ELSE 1 END";
const labels: Record<HistoryKind, string> = {
  opened: 'Request opened', status: 'Status changed', assigned: 'Assignee changed', priority: 'Priority changed', commented: 'Comment added'
};

/**
 * All reads and writes of requests, comments and history. Visibility is decided here, in one place:
 * requesters can only reach requests they opened; a request nobody owns (written before accounts existed) is staff-only.
 * `now` is injectable so the demo seed can write a believable timeline.
 */
export function createStore(db: DatabaseSync, now: () => Date = () => new Date()): Store {
  const byId = db.prepare(`SELECT ${SUMMARY},r.description FROM ${FROM} WHERE r.id=?`);
  const historyOf = db.prepare(`SELECT h.id,h.kind,h.actor_id,u.display_name AS actor_name,h.from_value AS "from",h.to_value AS "to",h.at
    FROM activity h LEFT JOIN users u ON u.id=h.actor_id WHERE h.request_id=? ORDER BY h.id`);
  const commentsOf = db.prepare(`SELECT c.id,c.author_id,u.display_name AS author_name,u.role AS author_role,c.body,c.created_at
    FROM comments c JOIN users u ON u.id=c.author_id WHERE c.request_id=? ORDER BY c.id`);
  const staffById = db.prepare("SELECT id,display_name FROM users WHERE id=? AND role IN ('agent','admin')");
  const writeEvent = db.prepare('INSERT INTO activity(request_id,event,previous_status,status,at,kind,actor_id,from_value,to_value) VALUES(?,?,?,?,?,?,?,?,?)');
  type Row = RequestSummary & {description: string};

  function load(actor: PublicUser, id: number): Row {
    const row = byId.get(id) as Row | undefined;
    if (!row || !(isStaff(actor.role) || row.requester_id === actor.id)) throw notFound('Request not found.');
    return row;
  }
  const detail = (row: Row): RequestDetail => ({
    ...row, next: transitions[row.status],
    history: historyOf.all(row.id) as unknown as HistoryEntry[], comments: commentsOf.all(row.id) as unknown as CommentEntry[]
  });
  function record(id: number, kind: HistoryKind, actor: PublicUser, status: Status, from: string | null, to: string | null, at: string): void {
    writeEvent.run(id, labels[kind], kind === 'status' ? from : null, status, at, kind, actor.id, from, to);
  }

  return {
    list(actor, query) {
      const where: string[] = [], params: (string | number)[] = [];
      if (!isStaff(actor.role)) { where.push('r.requester_id=?'); params.push(actor.id); }
      if (query.status) { where.push('r.status=?'); params.push(query.status); }
      if (query.priority) { where.push('r.priority=?'); params.push(query.priority); }
      if (query.assignee === 'none') where.push('r.assignee_id IS NULL');
      else if (query.assignee !== undefined) { where.push('r.assignee_id=?'); params.push(query.assignee); }
      if (query.q) { where.push("instr(lower(r.title||' '||r.requester||' '||r.team||' SR-'||r.id),lower(?))>0"); params.push(query.q); }
      const clause = where.length ? 'WHERE ' + where.join(' AND ') : '', direction = query.order === 'asc' ? 'ASC' : 'DESC';
      // ORDER BY is assembled from this fixed list only; no request value is ever interpolated into SQL.
      const orderBy = query.sort === 'priority' ? `${RANK} ${direction},r.updated_at DESC,r.id DESC`
        : `${query.sort === 'created' ? 'r.created_at' : 'r.updated_at'} ${direction},r.id ${direction}`;
      const total = (db.prepare(`SELECT count(*) AS n FROM requests r ${clause}`).get(...params) as {n: number}).n;
      const items = db.prepare(`SELECT ${SUMMARY} FROM ${FROM} ${clause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`).all(...params, query.limit, query.offset) as unknown as RequestSummary[];
      return {items, total, limit: query.limit, offset: query.offset};
    },
    get: (actor, id) => detail(load(actor, id)),
    create(actor, input) {
      return transaction(db, () => {
        const {id} = db.prepare('SELECT max(coalesce((SELECT max(id) FROM requests),1039),1039)+1 AS id').get() as {id: number};
        const at = now().toISOString();
        db.prepare('INSERT INTO requests(id,title,requester,team,description,status,created_at,updated_at,priority,requester_id) VALUES(?,?,?,?,?,?,?,?,?,?)')
          .run(id, input.title, actor.display_name, input.team, input.description, 'Open', at, at, input.priority, actor.id);
        record(id, 'opened', actor, 'Open', null, 'Open', at);
        return detail(load(actor, id));
      });
    },
    update(actor, id, changes, revision) {
      return transaction(db, () => {
        const row = load(actor, id);   // 404 first: whether a request exists is only revealed to people who may read it
        if (!isStaff(actor.role)) throw forbidden('Only agents and admins can change a request.');
        if (revision === null) throw preconditionRequired('A current request revision is required in If-Match.');
        if (row.revision !== revision) throw preconditionFailed('Someone updated this request. Review the latest version before trying again.');
        // A value that already matches is not a change: no new revision and no history entry for it.
        const status = changes.status !== undefined && changes.status !== row.status ? changes.status : undefined;
        if (status && !transitions[row.status].includes(status)) throw conflict('That status change is not available. Refresh the request and try again.');
        const priority = changes.priority !== undefined && changes.priority !== row.priority ? changes.priority : undefined;
        let assignee: {id: number | null; name: string | null} | undefined;
        if (changes.assignee !== undefined && changes.assignee !== row.assignee) {
          const target = changes.assignee === null ? null : staffById.get(changes.assignee) as {id: number; display_name: string} | undefined;
          if (target === undefined) throw invalid('Assignee must be an agent or admin.');
          assignee = {id: target?.id ?? null, name: target?.display_name ?? null};
        }
        if (status === undefined && priority === undefined && assignee === undefined) return detail(row);
        const at = now().toISOString(), after = status ?? row.status;
        db.prepare('UPDATE requests SET status=?,priority=?,assignee_id=?,updated_at=?,revision=revision+1 WHERE id=? AND revision=?')
          .run(after, priority ?? row.priority, assignee ? assignee.id : row.assignee, at, id, revision);
        if (status) record(id, 'status', actor, after, row.status, status, at);
        if (assignee) record(id, 'assigned', actor, after, row.assignee_name, assignee.name, at);
        if (priority) record(id, 'priority', actor, after, row.priority, priority, at);
        return detail(load(actor, id));
      });
    },
    addComment(actor, id, body) {
      return transaction(db, () => {
        const row = load(actor, id), at = now().toISOString();
        const {lastInsertRowid} = db.prepare('INSERT INTO comments(request_id,author_id,body,created_at) VALUES(?,?,?,?)').run(id, actor.id, body, at);
        db.prepare('UPDATE requests SET updated_at=? WHERE id=?').run(at, id);   // moves it up the queue; the revision is untouched
        record(id, 'commented', actor, row.status, null, null, at);
        return {id: Number(lastInsertRowid), author_id: actor.id, author_name: actor.display_name, author_role: actor.role, body, created_at: at};
      });
    }
  };
}
