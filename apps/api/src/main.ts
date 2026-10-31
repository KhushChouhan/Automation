import { buildApp } from './app.js';

const port = Number(process.env['PORT'] ?? process.env['API_PORT'] ?? '8000');
const host = process.env['API_HOST'] ?? '0.0.0.0';

try {
  const app = await buildApp();
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error('Port must be between 1 and 65535');
  await app.listen({ port, host });
  console.log(`[API] Fastify HTTP server listening on ${host}:${port}`);
} catch (error) {
  console.error('[API] Startup failed:', error);
  process.exitCode = 1;
}
