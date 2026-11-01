import { spawn } from 'node:child_process';

console.log('[PROD] Starting Instagram Reels Automation (Unified Engine)...');

// Global error handlers so crashes are never silent
process.on('uncaughtException', (err) => {
  console.error('[PROD uncaughtException]:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[PROD unhandledRejection]:', reason);
});

// 1. Embedded Redis startup if localhost, empty, or default
const rawRedisUrl = (process.env['REDIS_URL'] ?? '').trim();
const isLocalRedis =
  !rawRedisUrl ||
  rawRedisUrl.includes('127.0.0.1') ||
  rawRedisUrl.includes('localhost') ||
  rawRedisUrl === 'redis://127.0.0.1:6379';

if (isLocalRedis) {
  process.env['REDIS_URL'] = 'redis://127.0.0.1:6379';
  console.log('[PROD] Launching embedded Redis server for queue processing...');
  try {
    const redisProc = spawn('redis-server', ['--daemonize', 'yes', '--protected-mode', 'no', '--port', '6379'], {
      stdio: 'inherit',
    });
    redisProc.on('error', (err) => {
      console.warn('[PROD] Note: Could not spawn embedded redis-server:', err.message);
    });
    // Give redis-server 1 second to bind port 6379
    await new Promise((resolve) => setTimeout(resolve, 1000));
    console.log('[PROD] Embedded Redis server started.');
  } catch (err) {
    console.warn('[PROD] Note on embedded redis:', err);
  }
}

// 2. Sync PostgreSQL database schema using Prisma db push
if (process.env['DATABASE_URL']) {
  console.log('[PROD] Connecting to PostgreSQL and synchronizing database schema...');
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        const proc = spawn(
          'node',
          ['node_modules/prisma/build/index.js', 'db', 'push', '--schema', 'prisma/schema.prisma', '--skip-generate'],
          { stdio: 'inherit' },
        );
        proc.on('close', (code) => {
          if (code === 0) resolve(undefined);
          else reject(new Error(`Prisma schema sync exited with code ${code}`));
        });
      });
      console.log('[PROD] Database schema synchronized successfully.');
      break;
    } catch (err) {
      console.warn(
        `[PROD] Schema sync attempt ${attempt}/5: ${err instanceof Error ? err.message : String(err)}. Retrying in 2s...`,
      );
      if (attempt === 5) {
        console.error('[PROD] Database schema sync could not complete. Continuing service launch...');
      } else {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  // Self-heal stale sync conflicts from previous failed syncs
  try {
    const { PrismaClient } = await import('@prisma/client');
    const healDb = new PrismaClient();
    const healed = await healDb.syncConflict.updateMany({
      where: { resolvedAt: null, reason: { in: ['UNRESOLVED_CONFLICT', 'UNKNOWN_OR_INACTIVE_FACE'] } },
      data: { resolvedAt: new Date() },
    });
    if (healed.count > 0) {
      console.log(`[PROD] Self-healed ${healed.count} legacy sync conflict records.`);
    }
    await healDb.$disconnect();
  } catch (err) {
    console.warn('[PROD] Conflict heal notice:', err instanceof Error ? err.message : String(err));
  }
}

// 3. Start Fastify API and Worker concurrently
console.log('[PROD] Initializing Fastify API and Background Automation Worker...');
try {
  await Promise.all([
    import('../apps/api/dist/main.js'),
    import('../apps/worker/dist/main.js'),
  ]);
  console.log('[PROD] Unified Engine is running.');
} catch (error) {
  console.error('[PROD] Fatal error starting services:', error);
  process.exit(1);
}
