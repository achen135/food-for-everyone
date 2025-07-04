import type { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";

import { getAuthenticatedUser } from "@/lib/auth/user";
import { BrandMark } from "@/components/brand-mark";

/**
 * Shell for /sign-in, /sign-up and /verify-email.
 *
 * The header exists because without it this route group was a dead end (M9):
 * the three pages linked only to each other, so a visitor who clicked "Sign in"
 * from the landing page could get back only with the browser's back button. The
 * wordmark is the same link home the landing header carries, and it renders
 * before the auth check so it is present on every one of these pages — the
 * `redirect` below only ever fires for users who are leaving anyway.
 */
export default async function AuthLayout({
  children,
}: {
  children: ReactNode;
}) {
  const user = await getAuthenticatedUser();

  if (user) {
    redirect("/app");
  }

  return (
    <>
      <header className="border-border border-b">
        <div className="mx-auto flex w-full max-w-6xl items-center px-6 py-4 sm:px-10">
          {/*
            The visible wordmark is the link's accessible name, so it announces
            as "Food For Everyone, link" rather than needing a label of its own.
          */}
          <Link
            href="/"
            className="hover:text-brand flex items-center gap-2.5 rounded-sm transition-colors"
          >
            <BrandMark className="text-brand size-6" />
            <span className="font-heading text-lg font-semibold tracking-tight">
              Food For Everyone
            </span>
          </Link>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-6 py-16">
        {children}
      </main>
    </>
  );
}
