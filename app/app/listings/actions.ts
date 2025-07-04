"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  cancelListing,
  claimListing,
  completeListing,
  createListing,
  releaseClaim,
} from "@/lib/db";
import { getAuthenticatedUser } from "@/lib/auth/user";
import {
  listingSchema,
  messageForCode,
  toInstant,
} from "@/lib/validation/listing";

export type ListingResult =
  | { ok: true }
  | { ok: false; message: string; fieldErrors?: Record<string, string[]> };

const idSchema = z.uuid("Unknown listing");

async function requireSession(): Promise<boolean> {
  const user = await getAuthenticatedUser();
  return Boolean(user);
}

function refresh(): void {
  revalidatePath("/app/listings");
  revalidatePath("/app");
}

/**
 * Every action re-checks the session, then leans on the database function for
 * authorization — which side you are, whether the transition is legal, and
 * whether you're the read-only demo account. None of that is decided here, so
 * a bug in this file can't grant anything.
 */
export async function createListingAction(
  input: unknown,
): Promise<ListingResult> {
  if (!(await requireSession())) {
    return { ok: false, message: "Your session expired. Sign in again." };
  }

  const parsed = listingSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      message: "Check the highlighted fields.",
      fieldErrors: z.flattenError(parsed.error).fieldErrors,
    };
  }

  const pickupStart = toInstant(parsed.data.pickupStart);
  const pickupEnd = toInstant(parsed.data.pickupEnd);
  if (!pickupStart || !pickupEnd) {
    return { ok: false, message: "Enter a valid pickup window." };
  }

  try {
    const code = await createListing({
      title: parsed.data.title,
      quantity: parsed.data.quantity,
      pickupStart,
      pickupEnd,
      notes: parsed.data.notes.trim() || null,
    });
    const message = messageForCode(code);
    if (message) return { ok: false, message };
  } catch {
    return { ok: false, message: "Could not post that listing. Try again." };
  }

  refresh();
  return { ok: true };
}

/** Shared shape for the four id-only lifecycle actions. */
function lifecycleAction(
  run: (id: string) => Promise<import("@/lib/db").ListingActionCode>,
  failure: string,
) {
  return async function action(listingId: unknown): Promise<ListingResult> {
    if (!(await requireSession())) {
      return { ok: false, message: "Your session expired. Sign in again." };
    }

    const parsed = idSchema.safeParse(listingId);
    if (!parsed.success) {
      return { ok: false, message: "Unknown listing." };
    }

    try {
      const message = messageForCode(await run(parsed.data));
      if (message) return { ok: false, message };
    } catch {
      return { ok: false, message: failure };
    }

    refresh();
    return { ok: true };
  };
}

export async function claimListingAction(
  listingId: unknown,
): Promise<ListingResult> {
  return lifecycleAction(
    claimListing,
    "Could not claim that listing.",
  )(listingId);
}

export async function releaseClaimAction(
  listingId: unknown,
): Promise<ListingResult> {
  return lifecycleAction(
    releaseClaim,
    "Could not release that claim.",
  )(listingId);
}

export async function completeListingAction(
  listingId: unknown,
): Promise<ListingResult> {
  return lifecycleAction(
    completeListing,
    "Could not complete that listing.",
  )(listingId);
}

export async function cancelListingAction(
  listingId: unknown,
): Promise<ListingResult> {
  return lifecycleAction(
    cancelListing,
    "Could not cancel that listing.",
  )(listingId);
}
