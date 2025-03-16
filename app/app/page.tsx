import type { Metadata } from "next";

import { getMyProfile } from "@/lib/db";

export const metadata: Metadata = { title: "Dashboard" };

export default async function AppHomePage() {
  const profile = await getMyProfile();
  const firstName = profile?.full_name?.trim().split(/\s+/)[0];

  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          Welcome{firstName ? `, ${firstName}` : ""}
        </h1>
        <p className="text-muted-foreground">
          You&rsquo;re signed in. Your account is ready.
        </p>
      </div>

      <div className="border-border rounded-xl border border-dashed p-6">
        <h2 className="font-heading text-base font-medium">
          Next: your organization
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">
          In M2 you&rsquo;ll add your organization&rsquo;s name, type, contact
          details, and address (geocoded from a search). In M3 the map opens.
        </p>
      </div>
    </div>
  );
}
