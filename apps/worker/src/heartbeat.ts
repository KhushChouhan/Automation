export const WORKER_HEARTBEAT_KEY = 'gcs:worker:heartbeat';
export const WORKER_HEARTBEAT_TTL_SECONDS = 60;

export interface HeartbeatOptions {
  redis: {
    status: string;
    set(key: string, value: string, mode: 'EX', ttl: number): Promise<unknown>;
  };
  queues: number;
  revision?: string;
  startedAt: Date;
  isRunning: () => boolean;
  warn: () => void;
  now?: () => Date;
}

/** No offline buffering: a disconnected runtime must not refresh its old heartbeat later. */
export function createHeartbeatWriter(options: HeartbeatOptions): () => Promise<boolean> {
  let inFlight = false;
  return async () => {
    if (inFlight || options.redis.status !== 'ready' || !options.isRunning()) return false;
    inFlight = true;
    try {
      const revision = options.revision ?? 'unknown';
      await options.redis.set(
        WORKER_HEARTBEAT_KEY,
        JSON.stringify({
          revision: /^[a-zA-Z0-9._-]{1,128}$/.test(revision) ? revision : 'unknown',
          startedAt: options.startedAt.toISOString(),
          observedAt: (options.now?.() ?? new Date()).toISOString(),
          queues: options.queues,
        }),
        'EX',
        WORKER_HEARTBEAT_TTL_SECONDS,
      );
      return true;
    } catch {
      options.warn();
      return false;
    } finally {
      inFlight = false;
    }
  };
}
