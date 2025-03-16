import type { Metadata } from "next";
import Link from "next/link";

import { GoogleButton } from "@/components/auth/google-button";
import { SignUpForm } from "@/components/auth/sign-up-form";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const metadata: Metadata = { title: "Create an account" };

export default function SignUpPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Create an account</CardTitle>
        <CardDescription>
          Register your food bank, shelter, restaurant, or grocer.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <SignUpForm />

        <div className="text-muted-foreground flex items-center gap-3 text-xs">
          <span className="bg-border h-px flex-1" />
          or
          <span className="bg-border h-px flex-1" />
        </div>

        <GoogleButton label="Sign up with Google" />

        <p className="text-muted-foreground text-sm">
          Already registered?{" "}
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
