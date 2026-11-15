import {mkdirSync} from 'node:fs';
import type {Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {dirname} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {warnings, type Config} from './config.ts';
import {openDatabase} from './db.ts';
import {createLogger, type Logger} from './logger.ts';
import {hashPassword} from './passwords.ts';
import {DEMO_PASSWORD, seedDemo} from './seed.ts';
import {createApp} from './server.ts';
import {usersExist} from './users.ts';

export interface Output {out(line: string): void; err(line: string): void}
export interface Running {server: Server; db: DatabaseSync; url: string; stop(signal?: string): Promise<void>}
const stdio: Output = {out: line => process.stdout.write(line), err: line => process.stderr.write(line)};

/** Opens the database, seeds the demo if asked to, and listens. Separate from main.ts so tests can start and stop it in-process. */
export async function start(config: Config, io: Output = stdio): Promise<Running> {
  if (config.db !== ':memory:') mkdirSync(dirname(config.db), {recursive: true});
  const db = openDatabase(config.db), logger: Logger | undefined = createLogger(config.log, io.out);
  const info = (msg: string, extra: Record<string, unknown> = {}): void => logger?.({ts: new Date().toISOString(), msg, ...extra});
  try {
    if (config.seedDemo && !usersExist(db)) seedDemo(db, await hashPassword(DEMO_PASSWORD));
    const app = createApp({db, cookieSecure: config.cookieSecure, ...(logger ? {log: logger} : {})});
    await new Promise<void>((resolve, reject) => {
      app.server.once('error', reject);
      app.server.listen(config.port, config.host, () => { app.server.off('error', reject); resolve(); });
    });
    const {address, port} = app.server.address() as AddressInfo;
    const url = 'http://' + (address.includes(':') ? '[' + address + ']' : address) + ':' + port;
    if (config.log) for (const warning of warnings(config)) io.err('warning: ' + warning + '\n');
    info('listening', {url});
    return {
      server: app.server, db, url,
      async stop(signal) {
        info('shutting down', signal ? {signal} : {});
        await app.close();   // stop accepting, let running requests finish, then drop what is left after a grace period
        db.close();
        info('stopped');
      }
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
