import { GlobeIcon, MailIcon, MapPinIcon, PhoneIcon } from "lucide-react";

import type { OrgFeatureProperties } from "@/lib/geojson";
import { Badge } from "@/components/ui/badge";

/**
 * Popup body for one organization pin. Renders only the org-level fields the
 * API returns — there is deliberately nothing here about the person who
 * registered it (CLAUDE.md architecture rule).
 */
export function OrgPopupCard({ org }: { org: OrgFeatureProperties }) {
  return (
    <div className="grid max-w-[16rem] gap-2 text-sm">
      <div className="grid gap-1">
        <h3 className="font-heading pr-4 text-base leading-snug font-medium">
          {org.name}
        </h3>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="secondary" className="capitalize">
            {org.type}
          </Badge>
          {org.verified ? <Badge variant="outline">Verified</Badge> : null}
          <span className="text-muted-foreground text-xs">
            {org.distanceKm} km away
          </span>
        </div>
      </div>

      {org.description ? (
        <p className="text-muted-foreground line-clamp-4">{org.description}</p>
      ) : null}

      <dl className="grid gap-1">
        {org.address ? (
          <div className="flex items-start gap-2">
            <dt className="mt-0.5">
              <MapPinIcon className="text-muted-foreground size-3.5" />
              <span className="sr-only">Address</span>
            </dt>
            <dd className="text-muted-foreground">{org.address}</dd>
          </div>
        ) : null}

        {org.email ? (
          <div className="flex items-center gap-2">
            <dt>
              <MailIcon className="text-muted-foreground size-3.5" />
              <span className="sr-only">Email</span>
            </dt>
            <dd>
              <a
                href={`mailto:${org.email}`}
                className="text-brand hover:underline"
              >
                {org.email}
              </a>
            </dd>
          </div>
        ) : null}

        {org.phone ? (
          <div className="flex items-center gap-2">
            <dt>
              <PhoneIcon className="text-muted-foreground size-3.5" />
              <span className="sr-only">Phone</span>
            </dt>
            <dd>
              <a
                href={`tel:${org.phone.replace(/[^0-9+]/g, "")}`}
                className="text-brand hover:underline"
              >
                {org.phone}
              </a>
            </dd>
          </div>
        ) : null}

        {org.website ? (
          <div className="flex items-center gap-2">
            <dt>
              <GlobeIcon className="text-muted-foreground size-3.5" />
              <span className="sr-only">Website</span>
            </dt>
            <dd className="min-w-0">
              <a
                href={org.website}
                target="_blank"
                rel="noreferrer"
                className="text-brand block truncate hover:underline"
              >
                {org.website.replace(/^https?:\/\//, "")}
              </a>
            </dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}
