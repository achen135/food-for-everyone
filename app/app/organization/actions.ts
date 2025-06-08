"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  getMyOrganization,
  getMyProfile,
  invalidateOrganizationCache,
  upsertMyOrganization,
} from "@/lib/db";
import { geocodeAddress, type GeocodeResult } from "@/lib/geocode";
import { createClient } from "@/lib/supabase/server";
import {
  geocodeQuerySchema,
  needsFreshGeocode,
  organizationSchema,
} from "@/lib/validation/organization";

async function currentUserId(): Promise<string | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.id ?? null;
}

export type SearchAddressResult =
  { ok: true; results: GeocodeResult[] } | { ok: false; message: string };

/** Search-triggered geocoding — invoked by the "Search address" button only. */
export async function searchAddressAction(
  query: string,
): Promise<SearchAddressResult> {
  if (!(await currentUserId())) {
    return { ok: false, message: "Your session expired. Sign in again." };
  }

  const parsed = geocodeQuerySchema.safeParse({ q: query });
  if (!parsed.success) {
    return {
      ok: false,
      message:
        z.flattenError(parsed.error).fieldErrors.q?.[0] ?? "Invalid search.",
    };
  }

  try {
    return { ok: true, results: await geocodeAddress(parsed.data.q) };
  } catch {
    return {
      ok: false,
      message:
        "Address lookup is unavailable right now. Try again in a moment.",
    };
  }
}

export type SaveOrganizationResult =
  | { ok: true }
  | { ok: false; message: string; fieldErrors?: Record<string, string[]> };

export async function saveOrganizationAction(
  input: unknown,
): Promise<SaveOrganizationResult> {
  const userId = await currentUserId();
  if (!userId) {
    return { ok: false, message: "Your session expired. Sign in again." };
  }

  // RLS lets any authenticated user update their own org — read-only for the
  // demo account has to be enforced here, not by hiding the Save button. See
  // Spec §10, the M2 review lesson this checkpoint exists to fix.
  const profile = await getMyProfile();
  if (profile?.is_demo) {
    return { ok: false, message: "This is a read-only demo account." };
  }

  const parsed = organizationSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      message: "Check the highlighted fields.",
      fieldErrors: z.flattenError(parsed.error).fieldErrors,
    };
  }
  const v = parsed.data;

  const existing = await getMyOrganization();
  if (!existing && (v.latitude === null || v.longitude === null)) {
    return {
      ok: false,
      message: "Search for your address and pick a result before saving.",
      fieldErrors: { address: ["Search for your address and pick a result"] },
    };
  }

  if (
    existing &&
    needsFreshGeocode({
      storedAddress: existing.address,
      inputAddress: v.address,
      latitude: v.latitude,
      longitude: v.longitude,
    })
  ) {
    return {
      ok: false,
      message: "Search for your address again so the map pin matches it.",
      fieldErrors: {
        address: ["Re-run the address search to update the location"],
      },
    };
  }

  try {
    await upsertMyOrganization(userId, {
      name: v.name,
      type: v.type,
      description: v.description.trim() || null,
      email: v.email.trim() || null,
      phone: v.phone.trim() || null,
      website: normalizeWebsite(v.website),
      address: v.address,
      latitude: v.latitude,
      longitude: v.longitude,
    });
  } catch {
    return {
      ok: false,
      message: "Could not save your organization. Try again.",
    };
  }

  // Drop this user's cached org and map results before revalidating, so the
  // re-render that `revalidatePath` triggers reads the row we just wrote rather
  // than the copy cached moments ago.
  invalidateOrganizationCache(userId);

  revalidatePath("/app", "layout");
  revalidatePath("/app/organization");
  return { ok: true };
}

function normalizeWebsite(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  return /^https?:\/\//i.test(v) ? v : `https://${v}`;
}
