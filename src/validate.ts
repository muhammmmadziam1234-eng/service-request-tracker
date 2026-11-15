import {limits, priorities, sortKeys, sortOrders, statuses, teams, type Priority, type Status, type Team} from './domain.ts';
import {invalid} from './errors.ts';
import type {ListQuery} from './store.ts';

export interface NewRequest {title: string; team: Team; description: string; priority: Priority}
export interface Changes {status?: Status; priority?: Priority; assignee?: number | null}

const oneLine = /[\u0000-\u001F\u007F]/, multiLine = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === 'string' && (list as readonly string[]).includes(value);

function text(value: unknown, label: string, max: number, multiline = false): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw invalid(label + ' must be 1–' + max + ' characters.');
  if ((multiline ? multiLine : oneLine).test(value.trim())) throw invalid(label + ' contains characters that are not allowed.');
  return value.trim();
}
/** Unknown fields are refused rather than ignored, so a typo cannot silently do nothing. */
function onlyKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(body)) if (!allowed.includes(key)) throw invalid('Unknown field: ' + key.slice(0, 40) + '.');
}

export function parseNewRequest(body: Record<string, unknown>): NewRequest {
  onlyKeys(body, ['title', 'team', 'description', 'priority']);
  const title = text(body['title'], 'Title', limits.title), description = text(body['description'], 'Description', limits.description, true);
  if (!oneOf(teams, body['team'])) throw invalid('Select a valid team.');
  const priority = body['priority'] ?? 'Normal';
  if (!oneOf(priorities, priority)) throw invalid('Select a valid priority.');
  return {title, team: body['team'], description, priority};
}

export function parseChanges(body: Record<string, unknown>): Changes {
  onlyKeys(body, ['status', 'priority', 'assignee']);
  if (!Object.keys(body).length) throw invalid('Send at least one of status, priority or assignee.');
  const changes: Changes = {};
  if ('status' in body) { if (!oneOf(statuses, body['status'])) throw invalid('Select a valid status.'); changes.status = body['status']; }
  if ('priority' in body) { if (!oneOf(priorities, body['priority'])) throw invalid('Select a valid priority.'); changes.priority = body['priority']; }
  if ('assignee' in body) {
    const assignee = body['assignee'];
    if (assignee !== null && !(typeof assignee === 'number' && Number.isSafeInteger(assignee) && assignee > 0)) throw invalid('Assignee must be a user id or null.');
    changes.assignee = assignee;
  }
  return changes;
}

export function parseComment(body: Record<string, unknown>): string {
  onlyKeys(body, ['body']);
  return text(body['body'], 'Comment', limits.comment, true);
}

const queryNames = ['limit', 'offset', 'sort', 'order', 'status', 'priority', 'assignee', 'q'];
/** GET /api/requests parameters. Unknown or repeated parameters are errors; an empty value means "no filter". */
export function parseListQuery(params: URLSearchParams): ListQuery {
  for (const name of new Set(params.keys())) {
    if (!queryNames.includes(name)) throw invalid('Unknown query parameter: ' + name.slice(0, 40) + '.');
    if (params.getAll(name).length > 1) throw invalid('Send ' + name + ' only once.');
  }
  const get = (name: string): string | undefined => params.get(name) || undefined;
  const whole = (name: string, min: number, max: number, fallback: number): number => {
    const raw = get(name);
    if (raw === undefined) return fallback;
    if (!/^[0-9]{1,9}$/.test(raw) || Number(raw) < min || Number(raw) > max) throw invalid(name + ' must be a whole number from ' + min + ' to ' + max + '.');
    return Number(raw);
  };
  const choice = <T extends string>(name: string, list: readonly T[]): T | undefined => {
    const raw = get(name);
    if (raw !== undefined && !oneOf(list, raw)) throw invalid(name + ' must be one of: ' + list.join(', ') + '.');
    return raw as T | undefined;
  };
  const query: ListQuery = {
    sort: choice('sort', sortKeys) ?? 'updated', order: choice('order', sortOrders) ?? 'desc',
    limit: whole('limit', 1, limits.pageMax, limits.pageDefault), offset: whole('offset', 0, 100_000_000, 0)
  };
  const status = choice('status', statuses), priority = choice('priority', priorities), assignee = get('assignee'), q = get('q')?.trim();
  if (status) query.status = status;
  if (priority) query.priority = priority;
  if (assignee !== undefined) {
    if (assignee !== 'none' && !/^[1-9][0-9]{0,9}$/.test(assignee)) throw invalid('assignee must be a user id or none.');
    query.assignee = assignee === 'none' ? 'none' : Number(assignee);
  }
  if (q) {
    if (q.length > limits.search) throw invalid('Search must be ' + limits.search + ' characters or fewer.');
    query.q = q;
  }
  return query;
}
