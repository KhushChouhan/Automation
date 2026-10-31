import { NextResponse } from 'next/server';

export async function POST() {
  const baseUrl = process.env['API_BASE_URL'] ?? 'http://127.0.0.1:3001';
  try {
    const response = await fetch(`${baseUrl}/api/v1/sync/google`, {
      method: 'POST',
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        ...(process.env['ADMIN_API_TOKEN']
          ? { authorization: `Bearer ${process.env['ADMIN_API_TOKEN']}` }
          : {}),
      },
      body: '{}',
      signal: AbortSignal.timeout(5000),
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
