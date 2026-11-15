import {ConfigError, loadConfig, type Config} from './config.ts';
import {start} from './run.ts';

let config: Config;
try { config = loadConfig(process.env); } catch (error) {
  if (error instanceof ConfigError) { process.stderr.write(error.message + '\n'); process.exit(1); }
  throw error;
}
const running = await start(config);
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  // once: a second Ctrl-C while draining falls through to the default and ends the process at once
  process.once(signal, () => { running.stop(signal).then(() => process.exit(0), error => { console.error(error); process.exit(1); }); });
}
