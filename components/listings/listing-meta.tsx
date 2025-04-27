import { ClockIcon, MailIcon, MapPinIcon, PhoneIcon } from "lucide-react";

/** "31 Aug, 18:00 – 22:00" (same day) or both dates spelled out. */
export function formatWindow(startIso: string, endIso: string): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const day: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" };
  const time: Intl.DateTimeFormatOptions = {
    hour: "2-digit",
    minute: "2-digit",
  };

  const sameDay = start.toDateString() === end.toDateString();
  const startText = `${start.toLocaleDateString(undefined, day)}, ${start.toLocaleTimeString(undefined, time)}`;
  const endText = sameDay
    ? end.toLocaleTimeString(undefined, time)
    : `${end.toLocaleDateString(undefined, day)}, ${end.toLocaleTimeString(undefined, time)}`;

  return `${startText} – ${endText}`;
}

export function PickupWindow({
  pickupStart,
  pickupEnd,
}: {
  pickupStart: string;
  pickupEnd: string;
}) {
  return (
    <p className="text-muted-foreground flex items-center gap-2 text-sm">
      <ClockIcon className="size-3.5 shrink-0" />
      <time dateTime={pickupStart}>{formatWindow(pickupStart, pickupEnd)}</time>
    </p>
  );
}

/**
 * Contact details for the other side of a listing. Org-level fields only —
 * never anything about the person who registered the org.
 */
export function ContactLine({
  name,
  address,
  email,
  phone,
}: {
  name: string;
  address?: string | null;
  email?: string | null;
  phone?: string | null;
}) {
  return (
    <div className="grid gap-1 text-sm">
      <p className="font-medium">{name}</p>
      {address ? (
        <p className="text-muted-foreground flex items-start gap-2">
          <MapPinIcon className="mt-0.5 size-3.5 shrink-0" />
          <span>{address}</span>
        </p>
      ) : null}
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {email ? (
          <a
            href={`mailto:${email}`}
            className="text-brand flex items-center gap-1.5 hover:underline"
          >
            <MailIcon className="size-3.5" />
            {email}
          </a>
        ) : null}
        {phone ? (
          <a
            href={`tel:${phone.replace(/[^0-9+]/g, "")}`}
            className="text-brand flex items-center gap-1.5 hover:underline"
          >
            <PhoneIcon className="size-3.5" />
            {phone}
          </a>
        ) : null}
      </div>
    </div>
  );
}
