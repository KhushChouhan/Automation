import { describe, expect, it, vi } from 'vitest';
import { createHeartbeatWriter, WORKER_HEARTBEAT_KEY } from './heartbeat.js';

describe('worker heartbeat', () => {
  const startedAt = new Date('2026-11-02T10:00:00Z');
  it('expires worker evidence after a crash and renews after Redis reconnects', async () => {
    const redis = { status: 'ready', set: vi.fn().mockResolvedValue('OK') };
    let now = startedAt;
    const write = createHeartbeatWriter({
      redis,
      queues: 7,
      revision: 'abc123',
      startedAt,
      now: () => now,
      isRunning: () => true,
      warn: vi.fn(),
    });
    expect(await write()).toBe(true);
    expect(redis.set).toHaveBeenLastCalledWith(
      WORKER_HEARTBEAT_KEY,
      JSON.stringify({
        revision: 'abc123',
        startedAt: startedAt.toISOString(),
        observedAt: startedAt.toISOString(),
        queues: 7,
      }),
      'EX',
      60,
    );
    redis.status = 'reconnecting';
    expect(await write()).toBe(false);
    expect(redis.set).toHaveBeenCalledTimes(1);
    now = new Date('2026-11-02T10:02:00Z');
    redis.status = 'ready';
    expect(await write()).toBe(true);
    expect(JSON.parse(redis.set.mock.calls[1]![1] as string)).toMatchObject({
      observedAt: now.toISOString(),
    });
  });

  it('never claims paused workers are healthy and sanitizes connection failures and revision', async () => {
    const warn = vi.fn();
    const redis = { status: 'ready', set: vi.fn().mockRejectedValue(new Error('redis://secret')) };
    let running = false;
    const write = createHeartbeatWriter({
      redis,
      queues: 7,
      revision: 'bad secret value',
      startedAt,
      isRunning: () => running,
      warn,
    });
    expect(await write()).toBe(false);
    expect(redis.set).not.toHaveBeenCalled();
    running = true;
    expect(await write()).toBe(false);
    expect(warn).toHaveBeenCalledWith();
    expect(JSON.parse(redis.set.mock.calls[0]![1] as string)).toMatchObject({
      revision: 'unknown',
    });
    redis.set.mockResolvedValue('OK');
    expect(await write()).toBe(true);
  });

  it('avoids accumulating overlapping heartbeat writes', async () => {
    let finish!: (value: string) => void;
    const redis = {
      status: 'ready',
      set: vi.fn(
        () =>
          new Promise<string>((resolve) => {
            finish = resolve;
          }),
      ),
    };
    const write = createHeartbeatWriter({
      redis,
      queues: 7,
      startedAt,
      isRunning: () => true,
      warn: vi.fn(),
    });
    const first = write();
    expect(await write()).toBe(false);
    expect(redis.set).toHaveBeenCalledTimes(1);
    finish('OK');
    expect(await first).toBe(true);
  });
});
