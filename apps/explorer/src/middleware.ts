import { NextResponse, type NextRequest } from 'next/server';

export const config = {
  matcher: '/:path*',
};

const launchToken = crypto.randomUUID();

function hostnameMatchesLoopback(hostname: string | null): boolean {
  if (!hostname) return false;
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '[::1]';
}

function extractHostname(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).hostname || null;
  } catch {
    return null;
  }
}

function extractHostHeaderHostname(value: string | null): string | null {
  return value ? extractHostname(`http://${value}`) : null;
}

export function middleware(request: NextRequest): NextResponse {
  if (request.method === 'GET' && request.nextUrl.pathname === '/dogsled-logo.png') {
    return NextResponse.next();
  }
  const hostHostname = extractHostHeaderHostname(request.headers.get('host'));
  if (!hostnameMatchesLoopback(hostHostname)) {
    return NextResponse.json({ error: 'Explorer only accepts loopback requests' }, { status: 403 });
  }
  if (request.method !== 'GET') {
    const origin = request.headers.get('origin');
    let source: URL;
    try {
      source = new URL(origin ?? '');
    } catch {
      return NextResponse.json({ error: 'Cross-origin request rejected' }, { status: 403 });
    }
    if (
      !hostnameMatchesLoopback(source.hostname) ||
      source.origin !== `${request.nextUrl.protocol}//${request.headers.get('host')}` ||
      source.origin !== origin
    ) {
      return NextResponse.json({ error: 'Cross-origin request rejected' }, { status: 403 });
    }
    if (
      request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
      'application/json'
    ) {
      return NextResponse.json({ error: 'JSON content type required' }, { status: 415 });
    }
    if (request.headers.get('x-dogsled-explorer-token') !== launchToken) {
      return NextResponse.json({ error: 'Explorer launch token required' }, { status: 403 });
    }
  }
  const headers = new Headers(request.headers);
  headers.set('x-dogsled-explorer-token', launchToken);
  return NextResponse.next({ request: { headers } });
}
