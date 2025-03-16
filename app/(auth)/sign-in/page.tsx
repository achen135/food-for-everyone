import type { Metadata } from "next";
import Link from "next/link";

import { safeRedirectPath } from "@/lib/auth/redirect";
import { GoogleButton } from "@/components/auth/google-button";
import { SignInForm } from "@/components/auth/sign-in-form";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const metadata: Metadata = { title: "Sign in" };

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ redirectTo?: string }>;
}) {
  const { redirectTo: rawRedirect } = await searchParams;
  const redirectTo = rawRedirect ? safeRedirectPath(rawRedirect) : undefined;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Sign in</CardTitle>
        <CardDescription>
          Access your organization&rsquo;s profile and the map.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <SignInForm redirectTo={redirectTo} />

        <div className="text-muted-foreground flex items-center gap-3 text-xs">
          <span className="bg-border h-px flex-1" />
          or
          <span className="bg-border h-px flex-1" />
        </div>

        <GoogleButton redirectTo={redirectTo ?? "/app"} />

        <p className="text-muted-foreground text-sm">
          New here?{" "}
          <Link
            href="/sign-up"
            className="text-brand font-medium hover:underline"
          >
            Create an account
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
