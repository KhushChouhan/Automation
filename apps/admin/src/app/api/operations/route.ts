import { NextResponse } from 'next/server';

const routes = {
  generate: 'content/generate',
  regenerate: 'content/regenerate',
  'retry-content': 'content/retry',
  prepare: 'media/prepare',
  'retry-media': 'media/retry',
} as const;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    videoId?: unknown;
    action?: unknown;
  } | null;
  if (
    typeof body?.videoId !== 'string' ||
    !/^GCS-[0-9]{4,}$/.test(body.videoId) ||
    typeof body.action !== 'string' ||
    !(body.action in routes)
  )
    return NextResponse.json({ error: 'Invalid operation request' }, { status: 400 });

  const baseUrl = process.env['API_BASE_URL'] ?? 'http://127.0.0.1:3001';
  const route = routes[body.action as keyof typeof routes];
  try {
    const response = await fetch(`${baseUrl}/api/v1/videos/${body.videoId}/${route}`, {
      method: 'POST',
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        ...(process.env['ADMIN_API_TOKEN']
          ? { authorization: `Bearer ${process.env['ADMIN_API_TOKEN']}` }
          : {}),
      },
      body: '{}',
      signal: AbortSignal.timeout(5_000),
    });
    const result: unknown = await response.json();
    return NextResponse.json(result, {
      status: response.status,
      headers: { 'cache-control': 'no-store' },
    });
  } catch {
    return NextResponse.json({ error: 'Could not reach the API' }, { status: 503 });
  }
}
