import type { Metadata } from "next";
import Link from "next/link";

import { safeRedirectPath } from "@/lib/auth/redirect";
import { DEMO_EMAIL, DEMO_PASSWORD } from "@/lib/demo";
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
  searchParams: Promise<{ redirectTo?: string; demo?: string }>;
}) {
  const { redirectTo: rawRedirect, demo } = await searchParams;
  const redirectTo = rawRedirect ? safeRedirectPath(rawRedirect) : undefined;
  const isDemo = demo === "1";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">
          {isDemo ? "Sign in to the demo" : "Sign in"}
        </CardTitle>
        <CardDescription>
          {isDemo
            ? "Credentials are pre-filled below — just press Sign in. It's read-only: posting, claiming, and profile edits are disabled."
            : "Access your organization’s profile and the map."}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <SignInForm
          redirectTo={redirectTo ?? (isDemo ? "/app/map" : undefined)}
          defaultEmail={isDemo ? DEMO_EMAIL : undefined}
          defaultPassword={isDemo ? DEMO_PASSWORD : undefined}
        />

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
