// Runs the node:test suite (unit, HTTP API and contract tests; the browser tests are separate) with Node's built-in
// V8 coverage, prints line coverage per file of src/, and fails if the total is below the gate.
// Usage: node scripts/coverage-gate.ts [--write]     --write also saves the report to docs/evidence/coverage.txt
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const GATE = 85;
const root = fileURLToPath(new URL('..', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'relay-coverage-')), lcovPath = join(scratch, 'lcov.info');
const count = (output: string, label: string): number => Number(new RegExp('ℹ ' + label + ' (\\d+)').exec(output)?.[1] ?? NaN);
const pct = (hit: number, found: number): string => (found ? (100 * hit / found).toFixed(1) : '100.0') + '%';

try {
  const run = spawnSync(process.execPath, ['--test', '--experimental-test-coverage', '--test-coverage-include=src/**/*.ts',
    '--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=lcov', '--test-reporter-destination=' + lcovPath, 'test/**/*.test.ts'],
  {cwd: root, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024});
  const tests = count(run.stdout, 'tests'), passed = count(run.stdout, 'pass'), failed = count(run.stdout, 'fail');
  if (run.status !== 0 || failed !== 0) { process.stdout.write(run.stdout + run.stderr); console.error('The tests failed; coverage is not reported.'); process.exit(1); }

  const files = readFileSync(lcovPath, 'utf8').split('end_of_record').map(block => {
    const field = (key: string): number => Number(new RegExp('^' + key + ':(\\d+)$', 'm').exec(block)?.[1] ?? 0);
    const source = /^SF:(.+)$/m.exec(block)?.[1];
    if (!source) return null;
    // Node's reporter counts every source line, blank and comment-only ones included, which flatters the figure.
    // So the gate counts only lines that hold code: DA records on blank lines and comment-only lines are dropped.
    let inComment = false;
    const holdsCode = readFileSync(resolve(root, source), 'utf8').split('\n').map(line => {
      const text = line.trim();
      if (inComment) { if (text.includes('*/')) { inComment = false; return text.slice(text.indexOf('*/') + 2).trim() !== ''; } return false; }
      if (text.startsWith('/*')) { if (!text.includes('*/')) { inComment = true; return false; } return text.slice(text.indexOf('*/') + 2).trim() !== ''; }
      return text !== '' && !text.startsWith('//');
    });
    let lf = 0, lh = 0;
    for (const record of block.matchAll(/^DA:(\d+),(\d+)/gm)) if (holdsCode[Number(record[1]) - 1]) { lf++; if (Number(record[2]) > 0) lh++; }
    return {file: relative(root, resolve(root, source)), lf, lh, allLines: field('LF'), allHit: field('LH'), brf: field('BRF'), brh: field('BRH'), fnf: field('FNF'), fnh: field('FNH')};
  }).filter((entry): entry is NonNullable<typeof entry> => entry !== null).sort((a, b) => a.file.localeCompare(b.file));
  const sum = (key: 'lf' | 'lh' | 'allLines' | 'allHit' | 'brf' | 'brh' | 'fnf' | 'fnh'): number => files.reduce((total, entry) => total + entry[key], 0);
  const rows = files.map(e => `${e.file.padEnd(20)} ${pct(e.lh, e.lf).padStart(7)} (${e.lh}/${e.lf})`.padEnd(48) + `${pct(e.brh, e.brf).padStart(7)} (${e.brh}/${e.brf})`.padEnd(18) + `${pct(e.fnh, e.fnf).padStart(7)} (${e.fnh}/${e.fnf})`);
  const total = `${'TOTAL'.padEnd(20)} ${pct(sum('lh'), sum('lf')).padStart(7)} (${sum('lh')}/${sum('lf')})`.padEnd(48) + `${pct(sum('brh'), sum('brf')).padStart(7)} (${sum('brh')}/${sum('brf')})`.padEnd(18) + `${pct(sum('fnh'), sum('fnf')).padStart(7)} (${sum('fnh')}/${sum('fnf')})`;
  const linePercent = 100 * sum('lh') / sum('lf');

  const kinds: Record<string, string> = {
    'passwords.test.ts': 'unit', 'throttle.test.ts': 'unit', 'config.test.ts': 'unit', 'static.test.ts': 'unit', 'migrate.test.ts': 'unit (database)',
    'auth.test.ts': 'integration (HTTP)', 'api.test.ts': 'integration (HTTP)', 'roles.test.ts': 'integration (HTTP)', 'domain.test.ts': 'integration (HTTP)',
    'list.test.ts': 'integration (HTTP)', 'ops.test.ts': 'integration (HTTP)', 'headers.test.ts': 'integration (HTTP)', 'logging.test.ts': 'integration (HTTP)',
    'shutdown.test.ts': 'integration (process)', 'accounts.test.ts': 'integration (process)', 'contract.test.ts': 'contract (OpenAPI)'
  };
  const inventory = readdirSync(join(root, 'test')).filter(name => name.endsWith('.test.ts')).sort().map(name => {
    const alone = spawnSync(process.execPath, ['--test', join('test', name)], {cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
    return {name, kind: kinds[name] ?? 'other', tests: count(alone.stdout, 'tests')};
  });
  const byKind = new Map<string, number>();
  for (const entry of inventory) byKind.set(entry.kind.split(' ')[0]!, (byKind.get(entry.kind.split(' ')[0]!) ?? 0) + entry.tests);

  const report = [
    'Coverage of src/ by the unit, HTTP integration and contract tests (npm test).',
    'Measured with node --test --experimental-test-coverage (V8 coverage), Node ' + process.version + '.',
    `Gate: at least ${GATE}% of lines that hold code (scripts/coverage-gate.ts). The browser tests (npm run test:e2e) are not counted here.`,
    'Blank lines and comment-only lines are left out of "lines"; Node\'s own reporter counts them as covered lines, so its raw figure is higher (shown below the table).',
    'Reproduce and refresh this file: npm run coverage -- --write',
    '',
    `Tests: ${tests} run, ${passed} passed, ${failed} failed. A "test" here counts every subtest, e.g. each role x action cell.`,
    '',
    'file                 lines                          branches        functions',
    ...rows, total, '',
    `Line coverage ${linePercent.toFixed(1)}% of code lines against a gate of ${GATE}%: ${linePercent >= GATE ? 'PASS' : 'FAIL'}`,
    `For reference, Node's raw figure counting every source line: ${pct(sum('allHit'), sum('allLines'))} (${sum('allHit')}/${sum('allLines')}).`,
    '',
    'Tests per file (each file run on its own):',
    ...inventory.map(e => `  ${e.name.padEnd(20)} ${String(e.tests).padStart(4)}  ${e.kind}`),
    ...[...byKind].map(([kind, n]) => `  total ${kind}: ${n}`)
  ].join('\n') + '\n';
  process.stdout.write(report);
  if (process.argv.includes('--write')) writeFileSync(join(root, 'docs/evidence/coverage.txt'), report);
  if (linePercent < GATE) process.exit(1);
} finally {
  rmSync(scratch, {recursive: true, force: true});
}
