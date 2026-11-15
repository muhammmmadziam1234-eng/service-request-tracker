import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import type {AddressInfo} from 'node:net';
import {fileURLToPath} from 'node:url';
import {app} from './server.ts';
import {openStore} from './store.ts';

const path = process.env.REQUEST_DB || fileURLToPath(new URL('../data/requests.sqlite', import.meta.url));
mkdirSync(dirname(path), {recursive: true});
const server = app(openStore(path));
server.listen(Number(process.env.PORT || 4180), process.env.HOST || '127.0.0.1', () => {
  const {address, port} = server.address() as AddressInfo;
  console.log('Service Request Tracker: http://' + address + ':' + port);
});
