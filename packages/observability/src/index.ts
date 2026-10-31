import pino, { type LoggerOptions } from 'pino';

export function createLogger(options: LoggerOptions = {}) {
  return pino({ level: process.env['LOG_LEVEL'] ?? 'info', ...options });
}

export type AppLogger = ReturnType<typeof createLogger>;
