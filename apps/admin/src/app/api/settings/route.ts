import { NextResponse } from 'next/server';
import { authorizeMutation } from '../../authorize-mutation';

export async function PATCH(request: Request) {
  const denied = authorizeMutation(request);
  if (denied) return denied;
  const token = process.env['ADMIN_API_TOKEN'];
  const baseUrl = process.env['API_BASE_URL'];
  if (!token || (!baseUrl && process.env['NODE_ENV'] === 'production'))
    return NextResponse.json({ error: 'Admin API access is not configured' }, { status: 503 });
  const body: unknown = await request.json().catch(() => null);
  try {
    const response = await fetch(
      `${baseUrl ?? 'http://127.0.0.1:3001'}/api/v1/settings/scheduling`,
      {
        method: 'PATCH',
        cache: 'no-store',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      },
    );
    return NextResponse.json(await response.json(), {
      status: response.status,
      headers: { 'cache-control': 'no-store' },
    });
  } catch {
    return NextResponse.json({ error: 'Could not reach the API' }, { status: 503 });
  }
}
