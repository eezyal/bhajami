export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogPayload {
  route: string;
  message: string;
  runId?: string;
  errCode?: string;
  httpStatus?: number;
  docPath?: string;
  [key: string]: unknown;
}

/**
 * Emits a structured single-line JSON log record to stdout/stderr.
 * Never pass raw bearer tokens, private keys, or full credential payloads here.
 */
export function logEvent(level: LogLevel, payload: LogPayload): void {
  const entry = {
    ts: new Date().toISOString(),
    level,
    ...payload,
  };
  const serialized = JSON.stringify(entry);
  if (level === 'error') {
    console.error(serialized);
  } else if (level === 'warn') {
    console.warn(serialized);
  } else {
    console.log(serialized);
  }
}
