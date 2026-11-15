import {limits, priorities, statuses, teams, type Priority, type Status, type Team} from './domain.ts';
import {invalid} from './errors.ts';

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
