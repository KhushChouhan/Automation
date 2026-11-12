import { NextResponse } from 'next/server';
import { dashboardAuthenticated } from '../auth';

export function authorizeMutation(request: Request): NextResponse | null {
  if (!dashboardAuthenticated(request.headers.get('authorization'), process.env))
    return NextResponse.json({ error: 'Dashboard authentication required' }, { status: 401 });
  if (request.headers.get('origin') !== new URL(request.url).origin)
    return NextResponse.json({ error: 'Same-origin request required' }, { status: 403 });
  return null;
}
