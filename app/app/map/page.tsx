import type { Metadata } from "next";
import Link from "next/link";

import { getMyOrganization, getMyOrganizationPoint } from "@/lib/db";
import { MapPanel } from "@/components/map/map-panel";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Map" };

/** Donors are shown recipients, and vice versa. */
const COUNTERPARTY_LABEL = {
  donor: "recipients",
  recipient: "donors",
} as const;

export default async function MapPage() {
  const organization = await getMyOrganization();

  // The map is a directory of counterparties, and which side you see is derived
  // from your own organization. Without one there is nothing to show — the
  // `organizations_near` function would return zero rows anyway.
  if (!organization) {
    return (
      <EmptyState
        title="Set up your organization first"
        body="The map shows the other side of the exchange — donors see recipients, recipients see donors. We need to know which you are."
        cta="Set up organization"
      />
    );
  }

  const origin = await getMyOrganizationPoint();
  if (!origin) {
    return (
      <EmptyState
        title="Add your address"
        body="Your organization has no location yet, so we can't centre the map or work out who is nearby."
        cta="Add an address"
      />
    );
  }

  const counterpartyLabel = COUNTERPARTY_LABEL[organization.type];

  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          Nearby {counterpartyLabel}
        </h1>
        <p className="text-muted-foreground">
          {organization.type === "donor"
            ? "Organizations that can take surplus food from you."
            : "Organizations with surplus food to give."}{" "}
          Pick a pin for contact details.
        </p>
      </div>

      <MapPanel origin={origin} counterpartyLabel={counterpartyLabel} />
    </div>
  );
}

function EmptyState({
  title,
  body,
  cta,
}: {
  title: string;
  body: string;
  cta: string;
}) {
  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Map</h1>
      </div>
      <div className="border-border grid gap-3 rounded-xl border border-dashed p-6">
        <h2 className="font-heading text-base font-medium">{title}</h2>
        <p className="text-muted-foreground text-sm">{body}</p>
        <Button asChild className="w-fit">
          <Link href="/app/organization">{cta}</Link>
        </Button>
      </div>
    </div>
  );
}
