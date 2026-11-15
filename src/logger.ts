export interface RequestLog {ts: string; id: string; method: string; path: string; status: number; ms: number; user: number | null}
export interface ErrorLog {ts: string; level: 'error'; id: string; message: string}
export interface InfoLog {ts: string; msg: string; [key: string]: unknown}
export type LogEvent = RequestLog | ErrorLog | InfoLog;
export type Logger = (event: LogEvent) => void;

/**
 * The path as it is logged: query parameter names are kept, their values never are. Header values (cookies,
 * tokens) and request bodies (passwords) are not available to the logger at all.
 */
export function logPath(raw: string | undefined): string {
  try {
    const url = new URL(raw ?? '/', 'http://localhost');
    const names = [...new Set(url.searchParams.keys())].sort();
    return (url.pathname + (names.length ? '?' + names.join('&') : '')).slice(0, 200);
  } catch { return '(malformed)'; }
}

/** One JSON object per line. Returns undefined when logging is off, so callers cannot log by accident. */
export function createLogger(enabled: boolean, write: (line: string) => void): Logger | undefined {
  return enabled ? event => write(JSON.stringify(event) + '\n') : undefined;
}
