import { NextResponse } from 'next/server';
import { authorizeMutation } from '../../authorize-mutation';

export async function POST(request: Request) {
  const denied = authorizeMutation(request);
  if (denied) return denied;
  const body = (await request.json().catch(() => null)) as {
    videoId?: unknown;
    field?: unknown;
    value?: unknown;
  } | null;
  if (
    typeof body?.videoId !== 'string' ||
    !/^GCS-[0-9]{4,}$/.test(body.videoId) ||
    !['title', 'face'].includes(String(body.field)) ||
    typeof body.value !== 'string'
  )
    return NextResponse.json({ error: 'Invalid video input command' }, { status: 400 });
  const value = body.value.trim();
  const field = body.field === 'face' ? 'face' : 'title';
  const limit = field === 'face' ? 100 : 500;
  if (!value || value.length > limit)
    return NextResponse.json({ error: `Invalid ${field} value` }, { status: 400 });
  const token = process.env['ADMIN_API_TOKEN'];
  const baseUrl = process.env['API_BASE_URL'];
  if (!token || (!baseUrl && process.env['NODE_ENV'] === 'production'))
    return NextResponse.json({ error: 'Admin API access is not configured' }, { status: 503 });
  const payload = field === 'face' ? { faceName: value } : { title: value };
  try {
    const response = await fetch(
      `${baseUrl ?? 'http://127.0.0.1:3001'}/api/v1/videos/${body.videoId}/${field}`,
      {
        method: 'POST',
        cache: 'no-store',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
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
