import type { Metadata } from "next";
import Link from "next/link";

import {
  browseOpenListings,
  getListingRiskTiers,
  getMyClaims,
  getMyListings,
  getMyOrganization,
} from "@/lib/db";
import { isExpired } from "@/lib/validation/listing";
import {
  cancelListingAction,
  claimListingAction,
  completeListingAction,
  releaseClaimAction,
} from "@/app/app/listings/actions";
import { ListingActionButton } from "@/components/listings/listing-action-button";
import { ListingForm } from "@/components/listings/listing-form";
import { ListingRiskBadge } from "@/components/listings/listing-risk-badge";
import { ListingStatusBadge } from "@/components/listings/listing-status-badge";
import { ListingsRealtime } from "@/components/listings/listings-realtime";
import { ContactLine, PickupWindow } from "@/components/listings/listing-meta";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Donations" };

export default async function ListingsPage() {
  const organization = await getMyOrganization();

  if (!organization) {
    return (
      <div className="grid gap-6">
        <h1 className="text-2xl font-semibold tracking-tight">Donations</h1>
        <div className="border-border grid gap-3 rounded-xl border border-dashed p-6">
          <h2 className="font-heading text-base font-medium">
            Set up your organization first
          </h2>
          <p className="text-muted-foreground text-sm">
            Donors post surplus food here and recipients claim it. We need to
            know which side you&rsquo;re on.
          </p>
          <Button asChild className="w-fit">
            <Link href="/app/organization">Set up organization</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-8">
      <ListingsRealtime role={organization.type} />
      {organization.type === "donor" ? <DonorView /> : <RecipientView />}
    </div>
  );
}

// ------------------------------------------------------------------ donor

async function DonorView() {
  const listings = await getMyListings();
  const live = listings.filter(
    (l) => l.status === "open" || l.status === "claimed",
  );

  // M14: waste-risk tiers for the listings actually on screen. Returns an empty
  // map when the flag is off, the table is absent, or the batch job has not run
  // — the page then renders exactly as it did before M14. See
  // lib/db/listing-risk.ts for why this never surfaces an error.
  const risk = await getListingRiskTiers(live.map((l) => l.id));
  const past = listings.filter(
    (l) => l.status === "completed" || l.status === "cancelled",
  );

  return (
    <>
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          Post surplus food
        </h1>
        <p className="text-muted-foreground">
          Nearby recipients see open listings straight away and can claim them.
        </p>
      </div>

      <section className="border-border rounded-xl border p-6">
        <ListingForm />
      </section>

      <section className="grid gap-3">
        <h2 className="font-heading text-lg font-medium">
          Active listings{live.length ? ` (${live.length})` : ""}
        </h2>
        {live.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            Nothing posted yet. Anything you post shows up here.
          </p>
        ) : (
          <ul className="grid gap-3">
            {live.map((listing) => (
              <li
                key={listing.id}
                className="border-border grid gap-3 rounded-xl border p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="grid gap-1">
                    <h3 className="font-medium">{listing.title}</h3>
                    <p className="text-muted-foreground text-sm">
                      {listing.quantity}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <ListingRiskBadge tier={risk.get(listing.id)} />
                    <ListingStatusBadge
                      status={listing.status}
                      pickupEnd={listing.pickup_end}
                    />
                  </div>
                </div>

                <PickupWindow
                  pickupStart={listing.pickup_start}
                  pickupEnd={listing.pickup_end}
                />

                {listing.notes ? (
                  <p className="text-muted-foreground text-sm">
                    {listing.notes}
                  </p>
                ) : null}

                {listing.claimant_name ? (
                  <div className="bg-secondary rounded-lg p-3">
                    <p className="text-muted-foreground mb-1 text-xs font-medium tracking-wide uppercase">
                      Claimed by
                    </p>
                    <ContactLine
                      name={listing.claimant_name}
                      email={listing.claimant_email}
                      phone={listing.claimant_phone}
                    />
                  </div>
                ) : null}

                <div className="flex flex-wrap gap-2">
                  {listing.status === "claimed" ? (
                    <ListingActionButton
                      listingId={listing.id}
                      action={completeListingAction}
                      label="Mark completed"
                      pendingLabel="Saving…"
                      successMessage="Marked as completed."
                    />
                  ) : null}
                  <ListingActionButton
                    listingId={listing.id}
                    action={cancelListingAction}
                    label="Cancel"
                    pendingLabel="Cancelling…"
                    successMessage="Listing cancelled."
                    variant="ghost"
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {past.length > 0 ? (
        <section className="grid gap-3">
          <h2 className="font-heading text-lg font-medium">History</h2>
          <ul className="grid gap-2">
            {past.map((listing) => (
              <li
                key={listing.id}
                className="border-border flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3 text-sm"
              >
                <span className="font-medium">{listing.title}</span>
                <span className="text-muted-foreground">
                  {listing.quantity}
                </span>
                <ListingStatusBadge
                  status={listing.status}
                  pickupEnd={listing.pickup_end}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

// -------------------------------------------------------------- recipient

async function RecipientView() {
  const [claims, open] = await Promise.all([
    getMyClaims(),
    browseOpenListings({ radiusKm: 50 }),
  ]);

  return (
    <>
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          Available donations
        </h1>
        <p className="text-muted-foreground">
          Surplus food offered by donors near you. Claiming one shares your
          contact details with them.
        </p>
      </div>

      {claims.length > 0 ? (
        <section className="grid gap-3">
          <h2 className="font-heading text-lg font-medium">
            Your claims ({claims.length})
          </h2>
          <ul className="grid gap-3">
            {claims.map((claim) => (
              <li
                key={claim.id}
                className="border-brand/40 bg-secondary grid gap-3 rounded-xl border p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="grid gap-1">
                    <h3 className="font-medium">{claim.title}</h3>
                    <p className="text-muted-foreground text-sm">
                      {claim.quantity}
                    </p>
                  </div>
                  <ListingStatusBadge
                    status={claim.status}
                    pickupEnd={claim.pickup_end}
                  />
                </div>

                <PickupWindow
                  pickupStart={claim.pickup_start}
                  pickupEnd={claim.pickup_end}
                />

                {claim.notes ? (
                  <p className="text-muted-foreground text-sm">{claim.notes}</p>
                ) : null}

                <ContactLine
                  name={claim.donor_name}
                  address={claim.donor_address}
                  email={claim.donor_email}
                  phone={claim.donor_phone}
                />

                {claim.status === "claimed" ? (
                  <ListingActionButton
                    listingId={claim.listing_id}
                    action={releaseClaimAction}
                    label="Release claim"
                    pendingLabel="Releasing…"
                    successMessage="Claim released — it's back on offer."
                    variant="ghost"
                  />
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="grid gap-3">
        <h2 className="font-heading text-lg font-medium">
          Open nearby{open.length ? ` (${open.length})` : ""}
        </h2>

        {open.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            Nothing on offer within 50 km right now. New listings appear here
            the moment they&rsquo;re posted.
          </p>
        ) : (
          <ul className="grid gap-3">
            {open.map((listing) => (
              <li
                key={listing.id}
                className="border-border grid gap-3 rounded-xl border p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="grid gap-1">
                    <h3 className="font-medium">{listing.title}</h3>
                    <p className="text-muted-foreground text-sm">
                      {listing.quantity}
                    </p>
                  </div>
                  <span className="text-muted-foreground text-sm">
                    {listing.distance_km.toFixed(1)} km
                  </span>
                </div>

                <PickupWindow
                  pickupStart={listing.pickup_start}
                  pickupEnd={listing.pickup_end}
                />

                {listing.notes ? (
                  <p className="text-muted-foreground text-sm">
                    {listing.notes}
                  </p>
                ) : null}

                <ContactLine
                  name={listing.donor_name}
                  address={listing.donor_address}
                />

                {isExpired(listing.pickup_end) ? (
                  <p className="text-muted-foreground text-sm">
                    Pickup window has closed.
                  </p>
                ) : (
                  <ListingActionButton
                    listingId={listing.id}
                    action={claimListingAction}
                    label="Claim"
                    pendingLabel="Claiming…"
                    successMessage="Claimed — the donor's contact details are above."
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
