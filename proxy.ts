import { type NextRequest } from "next/server";

import { updateSession } from "@/lib/supabase/middleware";

// Next 16 renamed the `middleware` file convention to `proxy`. Runs before every
// matched request: refreshes the Supabase session cookie and gates /app/*.
export async function proxy(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Every path except:
     *  - _next/static, _next/image (build assets)
     *  - favicon.ico and common image extensions
     * Auth routes stay matched so the session cookie refreshes there too.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
