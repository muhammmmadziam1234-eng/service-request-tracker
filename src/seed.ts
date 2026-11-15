import type {DatabaseSync} from 'node:sqlite';
import {transaction} from './db.ts';
import type {Role} from './policy.ts';
import {createStore} from './store.ts';
import {createUser, findByUsername, usersExist} from './users.ts';

/** DEMO ONLY. Published in the README on purpose; a real deployment must not seed these accounts (SEED_DEMO=0). */
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

// The five requests of the original demo. They pre-date accounts, so they have no owner: only agents and admins see them.
const original: [number, string, string, string, string, string][] = [
  [1040, 'Set up a laptop for new starter', 'Avery Cole', 'IT', 'Prepare a laptop and standard software before the start date.', 'Completed'],
  [1041, 'Request access to the CRM', 'Noah Parker', 'Operations', 'Set up access for a new account coordinator.', 'Open'],
  [1042, 'Replace access badge', 'Taylor Reed', 'Facilities', 'The current access badge is unreliable at the east entrance. Please issue a replacement.', 'In progress'],
  [1043, 'Prepare a desk in Studio B', 'Riley Chen', 'Facilities', 'Set up a monitor, chair, and power supply at desk B12.', 'Assigned'],
  [1044, 'Update new starter checklist', 'Morgan Ellis', 'People', 'Add the equipment return and badge handover steps.', 'Open']
];
const flow = ['Open', 'Assigned', 'In progress', 'Completed'];

/**
 * Fictional sample requests, written once per database: the original five (metadata key seed-v1, which a version-1
 * database already has) and three owned by the demo requester, written through the store so they follow every rule.
 */
export function seedDemoRequests(db: DatabaseSync): void {
  const casey = findByUsername(db, 'casey'), riley = findByUsername(db, 'riley');
  transaction(db, () => {
    if (!db.prepare("SELECT key FROM metadata WHERE key='seed-v1'").get()) {
      const insert = db.prepare('INSERT INTO requests(id,title,requester,team,description,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)');
      const log = db.prepare('INSERT INTO activity(request_id,event,previous_status,status,at,kind,from_value,to_value) VALUES(?,?,?,?,?,?,?,?)');
      for (const [id, title, requester, team, description, status] of original) {
        const steps = flow.slice(0, flow.indexOf(status) + 1);
        const time = (i: number) => '2026-06-0' + (id - 1038) + 'T09:' + String(i * 10).padStart(2, '0') + ':00.000Z';
        insert.run(id, title, requester, team, description, status, time(0), time(steps.length - 1));
        steps.forEach((step, i) => log.run(id, i ? 'Status changed' : 'Request opened', steps[i - 1] ?? null, step, time(i), i ? 'status' : 'opened', steps[i - 1] ?? null, step));
      }
      db.prepare("INSERT INTO metadata VALUES('seed-v1')").run();
    }
    if (casey && riley && !db.prepare("SELECT key FROM metadata WHERE key='seed-v2'").get()) {
      let clock = new Date();
      const store = createStore(db, () => clock), at = (iso: string) => { clock = new Date(iso); };
      at('2026-06-08T08:30:00.000Z');
      store.create(casey, {title: 'Book a room for the Friday planning session', team: 'Operations', priority: 'Normal', description: 'Room for eight people from 10:00 to 12:00, with a screen.'});
      at('2026-06-08T09:10:00.000Z');
      const design = store.create(casey, {title: 'Install design software on my laptop', team: 'IT', priority: 'Normal', description: 'I need the vector graphics editor for the new brochure.'});
      at('2026-06-08T09:40:00.000Z');
      store.update(riley, design.id, {assignee: riley.id, priority: 'High', status: 'Assigned'}, 1);
      at('2026-06-09T10:15:00.000Z');
      store.update(riley, design.id, {status: 'In progress'}, 2);
      at('2026-06-09T10:20:00.000Z');
      store.addComment(riley, design.id, 'The licence request is with procurement. I will install it as soon as it arrives.');
      at('2026-06-09T11:05:00.000Z');
      store.addComment(casey, design.id, 'Thanks. Thursday is fine.');
      at('2026-06-09T07:55:00.000Z');
      const vpn = store.create(casey, {title: 'VPN disconnects every few minutes', team: 'IT', priority: 'Normal', description: 'The connection drops while working from home, usually after 5 to 10 minutes.'});
      at('2026-06-09T08:05:00.000Z');
      store.update(riley, vpn.id, {priority: 'Urgent', assignee: riley.id, status: 'Assigned'}, 1);
      at('2026-06-09T08:10:00.000Z');
      store.addComment(riley, vpn.id, 'Which network are you on, and does it happen on Wi-Fi and on a cable?');
      db.prepare("INSERT INTO metadata VALUES('seed-v2')").run();
    }
  });
}

/** Demo accounts and sample requests for an empty deployment. Does nothing once any account exists. */
export function seedDemo(db: DatabaseSync, passwordHash: string): boolean {
  if (!seedDemoUsers(db, passwordHash)) return false;
  seedDemoRequests(db);
  return true;
}
