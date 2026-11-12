import { headers } from 'next/headers';
import { dashboardAuthenticated } from '../auth';

export async function apiJson<T>(path: string): Promise<T> {
  const requestHeaders = await headers();
  if (!dashboardAuthenticated(requestHeaders.get('authorization'), process.env))
    throw new Error('Dashboard authentication required');
  const token = process.env['ADMIN_API_TOKEN'];
  if (!token) throw new Error('Admin API access is not configured');
  const baseUrl = process.env['API_BASE_URL'];
  if (!baseUrl && process.env['NODE_ENV'] === 'production')
    throw new Error('API_BASE_URL is required in production');
  const response = await fetch(`${baseUrl ?? 'http://127.0.0.1:3001'}${path}`, {
    cache: 'no-store',
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Operations API returned ${response.status}`);
  return response.json() as Promise<T>;
}
