import { spawn } from 'node:child_process';

console.log('[PROD] Starting Instagram Reels Automation (Unified Engine)...');

// 1. Run Prisma database migrations if DATABASE_URL is set
if (process.env['DATABASE_URL']) {
  console.log('[PROD] Checking database and executing pending migrations...');
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        const proc = spawn(
          'node',
          ['node_modules/prisma/build/index.js', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'],
          { stdio: 'inherit' },
        );
        proc.on('close', (code) => {
          if (code === 0) resolve(undefined);
          else reject(new Error(`Migration exited with code ${code}`));
        });
      });
      console.log('[PROD] Database schema is up to date.');
      break;
    } catch (err) {
      console.warn(`[PROD] Migration attempt ${attempt}/5: ${err instanceof Error ? err.message : String(err)}. Retrying in 2s...`);
      if (attempt === 5) {
        console.error('[PROD] Database migration could not complete. Continuing service launch...');
      } else {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }
}

// 2. Start API and Worker concurrently
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
