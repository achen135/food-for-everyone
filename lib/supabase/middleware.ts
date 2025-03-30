import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/** Route-group prefixes that require an authenticated user. */
const PROTECTED_PREFIXES = ["/app"];

/** True when `pathname` sits inside a protected route group. */
export function requiresAuth(pathname: string): boolean {
  return PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function redirectToSignIn(request: NextRequest) {
  const url = request.nextUrl.clone();
  url.pathname = "/sign-in";
  url.search = "";
  url.searchParams.set("redirectTo", request.nextUrl.pathname);
  return NextResponse.redirect(url);
}

/**
 * Runs in the proxy on every matched request. Two jobs:
 *  1. Refresh the Supabase auth cookie so Server Components always see a
 *     current session (they can't write cookies themselves).
 *  2. Redirect unauthenticated requests for protected routes to sign-in.
 *
 * The returned response's cookies must be preserved by the caller.
 */
export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    // Misconfiguration. We cannot verify a session, so we must not behave as if
    // we had: fail *closed* on protected routes and let public ones through.
    // (Previously this returned early in every environment, which silently
    // un-gated /app/* on a prod deploy with missing env — M1 review finding.)
    if (process.env.NODE_ENV === "production") {
      console.error(
        "[supabase] NEXT_PUBLIC_SUPABASE_* is not set — cannot verify sessions. Protected routes are being refused.",
      );
      if (requiresAuth(request.nextUrl.pathname)) {
        return redirectToSignIn(request);
      }
    } else {
      console.warn(
        "[supabase] NEXT_PUBLIC_SUPABASE_* not set — auth proxy is a no-op. Copy .env.example to .env.local.",
      );
    }
    return supabaseResponse;
  }

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        supabaseResponse = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          supabaseResponse.cookies.set(name, value, options);
        }
      },
    },
  });

  // IMPORTANT: getUser() (not getSession()) — it revalidates the token with the
  // Supabase Auth server. Do not run other logic between createServerClient and
  // this call, or you risk logging users out at random.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user && requiresAuth(request.nextUrl.pathname)) {
    return redirectToSignIn(request);
  }

  return supabaseResponse;
}
