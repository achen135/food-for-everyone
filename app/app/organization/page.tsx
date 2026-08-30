import type { Metadata } from "next";

import { getMyOrganization } from "@/lib/db";
import { OrganizationForm } from "@/components/organization/organization-form";

export const metadata: Metadata = { title: "Your organization" };

export default async function OrganizationPage() {
  const organization = await getMyOrganization();

  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          {organization ? "Edit your organization" : "Set up your organization"}
        </h1>
        <p className="text-muted-foreground">
          {organization
            ? "Update your details. Changes appear to counterparties on the map."
            : "Tell counterparties who you are, how to reach you, and where you operate."}
        </p>
      </div>

      <OrganizationForm initial={organization} />
    </div>
  );
}
