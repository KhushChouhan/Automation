import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { start, startupCommand } from '../../scripts/start.mjs';

const env = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://user:unused@db.internal/reels',
  REDIS_URL: 'rediss://cache.internal:6379',
};
const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

describe('deployment safety', () => {
  it('starts one runtime, never a hidden datastore or schema push', () => {
    expect(startupCommand(env, 'api')).toEqual(['apps/api/dist/main.js']);
    expect(startupCommand(env, 'worker')).toEqual(['apps/worker/dist/main.js']);
    expect(startupCommand(env, 'migrate')).toEqual([
      'node_modules/prisma/build/index.js',
      'migrate',
      'deploy',
      '--schema',
      'prisma/schema.prisma',
    ]);
    expect(read('scripts/start.mjs')).not.toMatch(/db.*push|redis-server|syncConflict/);
    expect(read('Dockerfile')).not.toMatch(/apk add.*redis|AS unified/);
  });

  it('fails before connecting when configuration could create an isolated queue', () => {
    for (const REDIS_URL of [
      '',
      'http://cache.internal',
      'redis://localhost:6379',
      'redis://127.0.0.1:6379',
      'redis://[::1]:6379',
    ])
      expect(() => startupCommand({ ...env, REDIS_URL })).toThrow();
    expect(() => startupCommand({ ...env, DATABASE_URL: '' }, 'migrate')).toThrow();
    expect(() => startupCommand(env, 'unified')).toThrow();
    expect(
      startupCommand({ ...env, NODE_ENV: 'development', REDIS_URL: 'redis://127.0.0.1:6380' }),
    ).toEqual(['apps/api/dist/main.js']);
  });

  it('propagates failed migrations and process exits for platform restart', async () => {
    for (const role of ['api', 'worker', 'migrate']) {
      const child = new EventEmitter();
      const spawn = vi.fn(() => {
        queueMicrotask(() => child.emit('exit', 17, null));
        return child;
      });
      expect(await start(env, role, spawn)).toBe(17);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(process.listenerCount('SIGTERM')).toBe(0);
    }
  });

  it('redacts spawn errors and removes signal handlers', async () => {
    const child = new EventEmitter();
    const spawn = () => {
      queueMicrotask(() => child.emit('error', new Error('secret')));
      return child;
    };
    await expect(start(env, 'worker', spawn)).rejects.toThrow('Runtime subprocess could not start');
    expect(process.listenerCount('SIGTERM')).toBe(0);
  });

  it('keeps managed production data services separate and publishing disabled', () => {
    const render = read('render.yaml');
    expect(render).toContain('type: worker');
    expect(render).toContain('type: keyvalue');
    expect(render).toContain('maxmemoryPolicy: noeviction');
    expect(render).toContain('persistenceMode: journal-snapshot');
    expect(render).toContain('plan: 256mb');
    expect(render).toContain('plan: 0.5c-512mb');
    expect(render).toContain('plan: 0.5c-1g');
    expect(render).not.toMatch(/plan: free|Unified/);
    expect(render).toContain('preDeployCommand: node scripts/start.mjs migrate');
    expect(render).toMatch(/key: INSTAGRAM_PUBLISHING_ENABLED\s+value: 'false'/);
    const compose = read('docker-compose.prod.yml');
    expect(compose).not.toMatch(/image: (redis|postgres):/);
    expect(compose).toContain('condition: service_completed_successfully');
    expect(JSON.parse(read('railway.json')).deploy.preDeployCommand).toEqual([
      'node scripts/start.mjs migrate',
    ]);
  });
});
