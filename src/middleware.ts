import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';

// How long the page-route auth check may take before the visitor is sent to /login instead of waiting for a 504.
export const AUTH_CHECK_TIMEOUT_MS = 6000;

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  // Skip middleware entirely for static assets and the login page itself.
  if (
    pathname.startsWith('/_next/') ||
    pathname === '/favicon.ico' ||
    pathname === '/login'
  ) {
    return NextResponse.next();
  }

  // API routes own their own auth via requireUser() / getUser() in the route
  // handler. The route handler's createClient() (using Next.js cookies()) handles
  // token refresh on its own — no middleware getUser() round-trip needed.
  if (pathname.startsWith('/api/')) {
    return NextResponse.next({ request });
  }

  // For page routes: refresh the session and redirect to login if unauthenticated.
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // Supabase Auth can be slow or failing (for example when the database is read-only). Without a limit the request hangs
  // until the platform cuts it off with a 504, so give up after a few seconds and send the visitor to the login page.
  let user: Awaited<ReturnType<typeof supabase.auth.getUser>>['data']['user'] = null;
  try {
    const result = await Promise.race([
      supabase.auth.getUser(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('auth check timed out')), AUTH_CHECK_TIMEOUT_MS)),
    ]);
    user = result.data.user;
  } catch {
    user = null;
  }

  if (!user) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = '/login';
    return NextResponse.redirect(loginUrl);
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|login).*)',
  ],
};
