import { buildApp } from './app.js';

const app = await buildApp();
const port = Number(process.env['API_PORT'] ?? '3001');
const host = process.env['API_HOST'] ?? '127.0.0.1';

try {
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error('API_PORT must be between 1 and 65535');
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error, 'API startup failed');
  await app.close();
  process.exitCode = 1;
}
