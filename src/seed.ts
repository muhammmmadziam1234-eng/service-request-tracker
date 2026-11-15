import type {DatabaseSync} from 'node:sqlite';
import {transaction} from './db.ts';
import type {Role} from './policy.ts';
import {createUser, usersExist} from './users.ts';

/** DEMO ONLY. Published in the README on purpose; real deployments must not seed these accounts. */
export const DEMO_PASSWORD = 'relay-demo-2026';
export const demoUsers: readonly {username: string; display_name: string; role: Role}[] = [
  {username: 'casey', display_name: 'Casey Lee', role: 'requester'},
  {username: 'riley', display_name: 'Riley Okafor', role: 'agent'},
  {username: 'morgan', display_name: 'Morgan Brooks', role: 'admin'}
];

/** Creates the three demo accounts, but only in a database that has no users yet. Returns true if it did. */
export function seedDemoUsers(db: DatabaseSync, passwordHash: string): boolean {
  if (usersExist(db)) return false;
  transaction(db, () => { for (const user of demoUsers) createUser(db, {...user, passwordHash}); });
  return true;
}

const sample: [number, string, string, string, string, string][] = [
  [1040, 'Set up a laptop for new starter', 'Avery Cole', 'IT', 'Prepare a laptop and standard software before the start date.', 'Completed'],
  [1041, 'Request access to the CRM', 'Noah Parker', 'Operations', 'Set up access for a new account coordinator.', 'Open'],
  [1042, 'Replace access badge', 'Taylor Reed', 'Facilities', 'The current access badge is unreliable at the east entrance. Please issue a replacement.', 'In progress'],
  [1043, 'Prepare a desk in Studio B', 'Riley Chen', 'Facilities', 'Set up a monitor, chair, and power supply at desk B12.', 'Assigned'],
  [1044, 'Update new starter checklist', 'Morgan Ellis', 'People', 'Add the equipment return and badge handover steps.', 'Open']
];
const flow = ['Open', 'Assigned', 'In progress', 'Completed'];

/** The five fictional sample requests of the original demo, written once (metadata key seed-v1). */
export function seedDemoRequests(db: DatabaseSync): void {
  const insert = db.prepare('INSERT INTO requests(id,title,requester,team,description,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)');
  const log = db.prepare('INSERT INTO activity(request_id,event,previous_status,status,at) VALUES(?,?,?,?,?)');
  transaction(db, () => {
    if (db.prepare("SELECT key FROM metadata WHERE key='seed-v1'").get()) return;
    for (const [id, title, requester, team, description, status] of sample) {
      const steps = flow.slice(0, flow.indexOf(status) + 1);
      const time = (i: number) => '2026-06-0' + (id - 1038) + 'T09:' + String(i * 10).padStart(2, '0') + ':00.000Z';
      insert.run(id, title, requester, team, description, status, time(0), time(steps.length - 1));
      steps.forEach((step, i) => log.run(id, i ? 'Status changed' : 'Request opened', steps[i - 1] ?? null, step, time(i)));
    }
    db.prepare("INSERT INTO metadata VALUES('seed-v1')").run();
  });
}
