import { spawn } from 'node:child_process';

console.log('[PROD] Starting Instagram Reels Automation (Unified Engine)...');

// Global error handlers so crashes are never silent
process.on('uncaughtException', (err) => {
  console.error('[PROD uncaughtException]:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[PROD unhandledRejection]:', reason);
});

// 1. Embedded Redis startup if localhost/default
const redisUrl = process.env['REDIS_URL'] || 'redis://127.0.0.1:6379';
if (redisUrl.includes('127.0.0.1') || redisUrl.includes('localhost')) {
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
