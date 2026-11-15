import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const dir = fileURLToPath(new URL('../public/', import.meta.url));
const files = readdirSync(dir), read = (name: string) => readFileSync(join(dir, name), 'utf8');

test('the page works under the strict CSP: no inline script, no inline style, no handler attributes, no outside hosts', () => {
  const html = read('index.html');
  for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    assert.match(script[1]!, /\bsrc="\/[^"]+"/, 'every script is an external file from this server');
    assert.equal(script[2]!.trim(), '', 'no inline script body');
  }
  assert.ok(!/<style\b/i.test(html), 'no <style> element');
  assert.ok(!/\sstyle\s*=/i.test(html), 'no style attribute');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline event handler');
  assert.ok(!/javascript:/i.test(html));
  for (const name of files.filter(file => /\.(html|css|js)$/.test(file))) assert.ok(!/https?:\/\//.test(read(name)), name + ' makes no reference to another host');
});
test('values from the server are only ever rendered as text, never parsed as HTML or code', () => {
  for (const name of files.filter(file => file.endsWith('.js'))) {
    const source = read(name);
    for (const banned of [/\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new Function\b/, /setTimeout\(\s*['"`]/, /\.srcdoc\b/])
      assert.ok(!banned.test(source), `${name} uses ${banned}`);
    assert.match(source, /^\/\/ @ts-check/m, name + ' is type-checked');
  }
});
test('the stylesheet has no motion at all, so reduced-motion preferences are respected by construction', () => {
  const css = read('style.css');
  assert.ok(!/transition|animation|@keyframes|scroll-behavior/.test(css));
});
test('the server serves exactly the files in public/', () => {
  assert.deepEqual(files.sort(), ['api.js', 'app.js', 'favicon.svg', 'index.html', 'style.css']);
});
