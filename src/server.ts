import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http';
import {readFile} from 'node:fs/promises';
import {InputError, type Store} from './store.ts';

const assets = new Map([['/', ['index.html', 'text/html']], ['/app.mjs', ['app.mjs', 'text/javascript']], ['/style.css', ['style.css', 'text/css']]]);
function json(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers}).end(JSON.stringify(value));
}
function detail(res: ServerResponse, status: number, item: {revision: number}): void {
  json(res, status, item, {ETag: '"' + item.revision + '"'});
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if ((req.headers['content-type'] || '').split(';')[0]!.trim().toLowerCase() !== 'application/json') throw new InputError('Send JSON for this request.', 415);
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const part of req.iterator({destroyOnReturn: false}) as AsyncIterable<Buffer>) {
    length += part.length;
    if (length > 8192) { req.resume(); throw new InputError('Request body is too large.', 413); }
    chunks.push(part);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new InputError('Invalid JSON.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new InputError('Expected a JSON object.');
  return parsed as Record<string, unknown>;
}

export function app(store: Store): Server {
  return createServer(async (req, res) => {
    try {
      let url: URL;
      try { url = new URL(req.url ?? '/', 'http://localhost'); } catch { throw new InputError('Malformed request address.'); }
      const path = url.pathname, method = req.method;
      if (path === '/api/requests' && method === 'GET') {
        json(res, 200, store.list({status: url.searchParams.get('status') ?? '', q: url.searchParams.get('q') ?? ''})); return;
      }
      if (path === '/api/requests' && method === 'POST') {
        detail(res, 201, store.add(await body(req))); return;
      }
      const match = path.match(/^\/api\/requests\/([0-9]{1,10})$/);
      if (match && method === 'GET') { detail(res, 200, store.get(Number(match[1]))); return; }
      if (match && method === 'PATCH') {
        const version = /^"([1-9][0-9]*)"$/.exec(req.headers['if-match'] ?? '');
        if (!version) throw new InputError('A current request revision is required in If-Match.', 428);
        detail(res, 200, store.update(Number(match[1]), (await body(req)).status, Number(version[1])));
        return;
      }
      const asset = assets.get(path);
      if (asset && method === 'GET') {
        const [name, type] = asset;
        const content = await readFile(new URL('../public/' + name, import.meta.url));
        res.writeHead(200, {'Content-Type': type + '; charset=utf-8', 'X-Content-Type-Options': 'nosniff'}).end(content); return;
      }
      const allowed = path === '/api/requests' ? 'GET, POST' : match ? 'GET, PATCH' : asset ? 'GET' : '';
      if (allowed) { json(res, 405, {error: 'Method not allowed.'}, {Allow: allowed}); return; }
      json(res, 404, {error: 'Not found.'});
    } catch (e) {
      if (e instanceof InputError) { json(res, e.status, {error: e.message}); return; }
      console.error(e); json(res, 500, {error: 'The request could not be completed.'});
    }
  });
}
