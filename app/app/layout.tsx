import type { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";

import { getOrCreateProfile } from "@/lib/db";
import { createClient } from "@/lib/supabase/server";
import { signOut } from "@/app/(auth)/actions";
import { Button } from "@/components/ui/button";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Middleware already gates /app; this is the defense-in-depth server check and
  // also where we guarantee a profile row exists.
  if (!user) {
    redirect("/sign-in?redirectTo=/app");
  }

  const profile = await getOrCreateProfile(user);

  return (
    <div className="flex min-h-full flex-col">
      <header className="border-border border-b">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-6 py-3">
          <div className="flex items-center gap-6">
            <Link href="/app" className="font-heading text-lg font-medium">
              Food For Everyone
            </Link>
            <nav className="flex items-center gap-4 text-sm">
              <Link href="/app" className="hover:text-brand">
                Dashboard
              </Link>
              <Link href="/app/listings" className="hover:text-brand">
                Donations
              </Link>
              <Link href="/app/map" className="hover:text-brand">
                Map
              </Link>
              <Link href="/app/organization" className="hover:text-brand">
                Organization
              </Link>
            </nav>
          </div>
          <div className="text-muted-foreground flex items-center gap-3 text-sm">
            <span className="hidden sm:inline">
              {profile.full_name ?? user.email}
            </span>
            <form
              action={async () => {
                "use server";
                await signOut();
              }}
            >
              <Button type="submit" variant="ghost" size="sm">
                Sign out
              </Button>
            </form>
          </div>
        </div>
      </header>
      <div className="mx-auto w-full max-w-5xl flex-1 px-6 py-8">
        {children}
      </div>
    </div>
  );
}
