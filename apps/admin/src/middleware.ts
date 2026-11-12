import { NextResponse, type NextRequest } from 'next/server';
import { dashboardAuthenticated } from './auth';

export function middleware(request: NextRequest) {
  if (!process.env['DASHBOARD_PASSWORD'])
    return new NextResponse(
      'Dashboard access is unavailable until DASHBOARD_PASSWORD is configured.',
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  if (!dashboardAuthenticated(request.headers.get('authorization'), process.env))
    return new NextResponse('Dashboard sign-in required', {
      status: 401,
      headers: {
        'www-authenticate': 'Basic realm="Reel operations", charset="UTF-8"',
        'cache-control': 'no-store',
      },
    });
  if (
    !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
    request.headers.get('origin') !== request.nextUrl.origin
  )
    return NextResponse.json({ error: 'Same-origin request required' }, { status: 403 });
  const response = NextResponse.next();
  response.headers.set('cache-control', 'no-store');
  return response;
}
export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
