import { NextResponse } from 'next/server';
import { authorizeMutation } from '../../../authorize-mutation';

export async function POST(request: Request) {
  const denied = authorizeMutation(request);
  if (denied) return denied;
  const baseUrl = process.env['API_BASE_URL'];
  if (!process.env['ADMIN_API_TOKEN'] || (!baseUrl && process.env['NODE_ENV'] === 'production'))
    return NextResponse.json({ error: 'Admin API access is not configured' }, { status: 503 });
  const resolvedBaseUrl = baseUrl ?? 'http://127.0.0.1:3001';
  try {
    const response = await fetch(`${resolvedBaseUrl}/api/v1/sync/google`, {
      method: 'POST',
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        ...(process.env['ADMIN_API_TOKEN']
          ? { authorization: `Bearer ${process.env['ADMIN_API_TOKEN']}` }
          : {}),
      },
      body: '{}',
      signal: AbortSignal.timeout(15_000),
    });
    const body: unknown = await response.json();
    return NextResponse.json(body, {
      status: response.status,
      headers: { 'cache-control': 'no-store' },
    });
  } catch {
    return NextResponse.json({ error: 'Could not reach the API' }, { status: 503 });
  }
}
