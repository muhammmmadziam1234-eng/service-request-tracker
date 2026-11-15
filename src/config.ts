import {isIP} from 'node:net';
import {fileURLToPath} from 'node:url';

export interface Config {port: number; host: string; db: string; cookieSecure: boolean; log: boolean; seedDemo: boolean}
export class ConfigError extends Error {
  problems: string[];
  constructor(problems: string[]) {
    super('Invalid configuration:\n' + problems.map(problem => '  - ' + problem).join('\n'));
    this.problems = problems;
  }
}

/** Reads and validates the environment once, at start. Every problem is reported together; an empty value counts as unset. */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const problems: string[] = [];
  const raw = (name: string): string | undefined => (env[name] === '' ? undefined : env[name]);
  const shown = (value: string): string => JSON.stringify(value);
  const choice = <T>(name: string, allowed: [string, T][], fallback: T): T => {
    const value = raw(name);
    if (value === undefined) return fallback;
    const found = allowed.find(([text]) => text === value);
    if (!found) { problems.push(`${name} must be ${allowed.map(([text]) => text).join(' or ')} (got ${shown(value)})`); return fallback; }
    return found[1];
  };
  let port = 4180;
  const portText = raw('PORT');
  if (portText !== undefined) {
    if (/^[0-9]{1,5}$/.test(portText) && Number(portText) <= 65535) port = Number(portText);
    else problems.push(`PORT must be a whole number from 0 to 65535 (got ${shown(portText)})`);
  }
  let host = '127.0.0.1';
  const hostText = raw('HOST');
  if (hostText !== undefined) {
    if (isIP(hostText) !== 0 || /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(hostText)) host = hostText;
    else problems.push(`HOST must be an IP address or a host name (got ${shown(hostText)})`);
  }
  let db = fileURLToPath(new URL('../data/requests.sqlite', import.meta.url));
  const dbText = raw('REQUEST_DB');
  if (dbText !== undefined) {
    if (dbText.includes('\u0000')) problems.push(`REQUEST_DB must be a file path or :memory: (got ${shown(dbText)})`);
    else db = dbText;
  }
  const cookieSecure = choice<boolean>('COOKIE_SECURE', [['1', true], ['0', false]], false);
  const log = choice<boolean>('LOG', [['on', true], ['off', false]], true);
  const seedDemo = choice<boolean>('SEED_DEMO', [['1', true], ['0', false]], true);
  if (problems.length) throw new ConfigError(problems);
  return {port, host, db, cookieSecure, log, seedDemo};
}

const loopback = (host: string): boolean => host === 'localhost' || host === '::1' || /^127\.[0-9.]+$/.test(host);
/** Settings that are fine on a laptop but unsafe once the server is reachable by others. */
export function warnings(config: Config): string[] {
  const out: string[] = [];
  if (!loopback(config.host) && config.seedDemo)
    out.push('The demo accounts (casey, riley, morgan) share a published password and this server listens beyond localhost. Set SEED_DEMO=0 for real use.');
  if (!loopback(config.host) && !config.cookieSecure)
    out.push('COOKIE_SECURE is not 1, so session cookies are sent without the Secure flag. Serve over HTTPS and set COOKIE_SECURE=1.');
  return out;
}
