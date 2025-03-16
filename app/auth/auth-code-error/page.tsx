import type { Metadata } from "next";
import Link from "next/link";

import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Sign-in link problem" };

export default function AuthCodeErrorPage() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-4 px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">
        That link didn&rsquo;t work
      </h1>
      <p className="text-muted-foreground">
        The confirmation or sign-in link is invalid or has already been used.
        Request a fresh one by signing in again.
      </p>
      <Button asChild className="w-fit">
        <Link href="/sign-in">Back to sign in</Link>
      </Button>
    </main>
  );
}
