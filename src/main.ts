import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import type {AddressInfo} from 'node:net';
import {fileURLToPath} from 'node:url';
import {openDatabase} from './db.ts';
import {hashPassword} from './passwords.ts';
import {DEMO_PASSWORD, seedDemo} from './seed.ts';
import {usersExist} from './users.ts';
import {createApp} from './server.ts';

const path = process.env.REQUEST_DB || fileURLToPath(new URL('../data/requests.sqlite', import.meta.url));
mkdirSync(dirname(path), {recursive: true});
const db = openDatabase(path);
if (!usersExist(db)) seedDemo(db, await hashPassword(DEMO_PASSWORD));
const {server} = createApp({db, cookieSecure: process.env.COOKIE_SECURE === '1'});
server.listen(Number(process.env.PORT || 4180), process.env.HOST || '127.0.0.1', () => {
  const {address, port} = server.address() as AddressInfo;
  console.log('Service Request Tracker: http://' + address + ':' + port);
});
