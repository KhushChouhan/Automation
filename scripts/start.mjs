import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** Validate without opening connections, starting Redis, or changing database state. */
export function startupCommand(env, role = env.PROCESS_ROLE ?? 'api') {
  if (!['api', 'worker', 'migrate'].includes(role))
    throw new Error('PROCESS_ROLE must be api, worker, or migrate');
  let database;
  try {
    database = new URL(env.DATABASE_URL ?? '');
  } catch {
    throw new Error('DATABASE_URL must be an explicit PostgreSQL URL');
  }
  if (!['postgres:', 'postgresql:'].includes(database.protocol))
    throw new Error('DATABASE_URL must use PostgreSQL');

  if (role === 'migrate')
    return [
      'node_modules/prisma/build/index.js',
      'migrate',
      'deploy',
      '--schema',
      'prisma/schema.prisma',
    ];

  let redis;
  try {
    redis = new URL(env.REDIS_URL ?? '');
  } catch {
    throw new Error('REDIS_URL must explicitly identify the shared Redis service');
  }
  if (!['redis:', 'rediss:'].includes(redis.protocol))
    throw new Error('REDIS_URL must use redis or rediss');
  if (
    env.NODE_ENV === 'production' &&
    ['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0'].includes(redis.hostname.toLowerCase())
  )
    throw new Error('Production requires a shared Redis service, not loopback Redis');
  return [`apps/${role}/dist/main.js`];
}

/** One supervised runtime per container. A failed migration or runtime fails the container. */
export async function start(
  env = process.env,
  role = process.argv[2] ?? env.PROCESS_ROLE ?? 'api',
  spawnProcess = spawn,
) {
  const args = startupCommand(env, role);
  const revision =
    env.APP_REVISION ?? env.RENDER_GIT_COMMIT ?? env.RAILWAY_GIT_COMMIT_SHA ?? 'unknown';
  console.log(
    JSON.stringify({
      operation: 'runtime.start',
      role,
      revision: /^[a-zA-Z0-9._-]{1,128}$/.test(revision) ? revision : 'unknown',
    }),
  );
  const child = spawnProcess(process.execPath, args, { stdio: 'inherit', env });
  const forward = (signal) => child.kill(signal);
  const onTerm = () => forward('SIGTERM');
  const onInt = () => forward('SIGINT');
  process.once('SIGTERM', onTerm);
  process.once('SIGINT', onInt);
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', () => reject(new Error('Runtime subprocess could not start')));
      child.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 1)));
    });
  } finally {
    process.off('SIGTERM', onTerm);
    process.off('SIGINT', onInt);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await start();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Runtime startup failed');
    process.exitCode = 1;
  }
}
