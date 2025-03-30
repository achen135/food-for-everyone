import type { Metadata } from "next";
import Link from "next/link";

import { getMyOrganization, getMyProfile } from "@/lib/db";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Dashboard" };

export default async function AppHomePage() {
  const [profile, organization] = await Promise.all([
    getMyProfile(),
    getMyOrganization(),
  ]);
  const firstName = profile?.full_name?.trim().split(/\s+/)[0];

  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          Welcome{firstName ? `, ${firstName}` : ""}
        </h1>
        <p className="text-muted-foreground">
          {organization
            ? "Your organization is set up."
            : "One step left: set up your organization."}
        </p>
      </div>

      {organization ? (
        <div className="border-border grid gap-3 rounded-xl border p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="grid gap-1">
              <h2 className="font-heading text-lg font-medium">
                {organization.name}
              </h2>
              <Badge variant="secondary" className="w-fit capitalize">
                {organization.type}
              </Badge>
            </div>
            <Button asChild variant="outline" size="sm">
              <Link href="/app/organization">Edit</Link>
            </Button>
          </div>

          {organization.description ? (
            <p className="text-muted-foreground text-sm">
              {organization.description}
            </p>
          ) : null}

          <dl className="grid gap-1 text-sm">
            <div className="flex gap-2">
              <dt className="text-muted-foreground w-20 shrink-0">Address</dt>
              <dd>{organization.address}</dd>
            </div>
            {organization.email ? (
              <div className="flex gap-2">
                <dt className="text-muted-foreground w-20 shrink-0">Email</dt>
                <dd>{organization.email}</dd>
              </div>
            ) : null}
            {organization.phone ? (
              <div className="flex gap-2">
                <dt className="text-muted-foreground w-20 shrink-0">Phone</dt>
                <dd>{organization.phone}</dd>
              </div>
            ) : null}
            {organization.website ? (
              <div className="flex gap-2">
                <dt className="text-muted-foreground w-20 shrink-0">Website</dt>
                <dd>
                  <a
                    href={organization.website}
                    target="_blank"
                    rel="noreferrer"
                    className="text-brand hover:underline"
                  >
                    {organization.website}
                  </a>
                </dd>
              </div>
            ) : null}
          </dl>

          <p className="text-muted-foreground text-sm">
            The map of nearby counterparties opens in M3.
          </p>
        </div>
      ) : (
        <div className="border-border grid gap-3 rounded-xl border border-dashed p-6">
          <h2 className="font-heading text-base font-medium">
            Set up your organization
          </h2>
          <p className="text-muted-foreground text-sm">
            Add your name, type, contact details, and address so counterparties
            can find you on the map.
          </p>
          <Button asChild className="w-fit">
            <Link href="/app/organization">Set up organization</Link>
          </Button>
        </div>
      )}
    </div>
  );
}
