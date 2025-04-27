import { z } from "zod";

import type { ListingActionCode, ListingStatus } from "@/lib/db/types";

/**
 * Listing form schema, shared between the client form and the Server Action.
 *
 * Pickup times arrive as `datetime-local` strings (no timezone), which is what
 * the user actually meant: "6pm" in front of the person typing it. They are
 * converted to instants at the boundary by `toInstant` below.
 */

const MAX_WINDOW_DAYS = 30;

/** `2026-08-31T18:00` → ISO instant in the runtime's zone. */
export function toInstant(localDateTime: string): string | null {
  const parsed = new Date(localDateTime);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

const localDateTime = z
  .string()
  .trim()
  .min(1, "Required")
  .refine(
    (v) => !Number.isNaN(new Date(v).getTime()),
    "Enter a valid date and time",
  );

export const listingSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1, "Say what you're offering")
      .max(120, "Keep the title under 120 characters"),
    quantity: z
      .string()
      .trim()
      .min(1, "Roughly how much?")
      .max(80, "Keep this under 80 characters"),
    pickupStart: localDateTime,
    pickupEnd: localDateTime,
    notes: z.string().trim().max(1000, "Keep notes under 1000 characters"),
  })
  .refine((v) => new Date(v.pickupEnd) > new Date(v.pickupStart), {
    message: "Pickup must end after it starts",
    path: ["pickupEnd"],
  })
  .refine(
    (v) =>
      new Date(v.pickupEnd).getTime() - new Date(v.pickupStart).getTime() <=
      MAX_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    {
      message: `Pickup window can't be longer than ${MAX_WINDOW_DAYS} days`,
      path: ["pickupEnd"],
    },
  );

export type ListingInput = z.infer<typeof listingSchema>;

/** A listing is expired when its pickup window has closed, whatever the row says. */
export function isExpired(pickupEnd: string, now: Date = new Date()): boolean {
  return new Date(pickupEnd).getTime() <= now.getTime();
}

/**
 * What to show the user for a listing, folding the derived "expired" state into
 * the stored status.
 */
export function effectiveStatus(
  status: ListingStatus,
  pickupEnd: string,
  now: Date = new Date(),
): ListingStatus | "expired" {
  return status === "open" && isExpired(pickupEnd, now) ? "expired" : status;
}

/** Human copy for each result code the database functions can return. */
const ACTION_MESSAGES: Record<Exclude<ListingActionCode, "ok">, string> = {
  no_organization: "Set up your organization first.",
  not_donor: "Only donor organizations can post listings.",
  not_recipient: "Only recipient organizations can claim listings.",
  demo_account: "This is a read-only demo account.",
  not_found: "That listing no longer exists.",
  not_open: "That listing is no longer open.",
  not_claimed: "That listing hasn't been claimed yet.",
  no_claim: "You don't have an active claim on that listing.",
  expired: "That listing's pickup window has closed.",
  already_claimed: "Someone else claimed that listing first.",
  bad_window: "Pickup must end after it starts.",
};

export function messageForCode(code: ListingActionCode): string | null {
  return code === "ok"
    ? null
    : (ACTION_MESSAGES[code] ?? "Something went wrong.");
}
