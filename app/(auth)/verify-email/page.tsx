import type { Metadata } from "next";
import Link from "next/link";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const metadata: Metadata = { title: "Confirm your email" };

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string }>;
}) {
  const { email } = await searchParams;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Confirm your email</CardTitle>
        <CardDescription>
          {email ? (
            <>
              We sent a confirmation link to <strong>{email}</strong>.
            </>
          ) : (
            <>We sent you a confirmation link.</>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="text-muted-foreground grid gap-3 text-sm">
        <p>
          Open it on this device to finish setting up your account. You can
          close this tab.
        </p>
        <p>
          Already confirmed?{" "}
          <Link
            href="/sign-in"
            className="text-brand font-medium hover:underline"
          >
            Sign in
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
