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
import { OutboundPaceSaturatedError } from "@/lib/pace";
import { geocodeLimiter, rateLimitingEnabled } from "@/lib/rate-limit";
import { getAuthenticatedUser } from "@/lib/auth/user";
import {
  geocodeQuerySchema,
  needsFreshGeocode,
  organizationSchema,
} from "@/lib/validation/organization";

async function currentUserId(): Promise<string | null> {
  const user = await getAuthenticatedUser();
  return user?.id ?? null;
}

export type SearchAddressResult =
  { ok: true; results: GeocodeResult[] } | { ok: false; message: string };

/**
 * Search-triggered geocoding — invoked by the "Search address" button only.
 *
 * Throttled twice over, because one mechanism cannot do both jobs (M9; see
 * lib/pace.ts for the full reasoning):
 *
 *   - `geocodeLimiter`, here, caps what a single account can spend;
 *   - `nominatimPacer`, inside `geocodeAddress`, caps what the whole process
 *     puts on the wire, which is what Nominatim's policy actually measures.
 *
 * Each of the three failure paths below says something different and true. None
 * of them returns an empty result list: "no results" is a claim about the
 * *address*, and we are not entitled to make it when the reason is us.
 */
export async function searchAddressAction(
  query: string,
): Promise<SearchAddressResult> {
  const userId = await currentUserId();
  if (!userId) {
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

  // Charged after validation, not before: a query zod rejects never reaches
  // Nominatim, so it should not cost the user any of a budget that exists to
  // ration outbound calls. (This is the opposite order from /api/orgs, where
  // the limiter runs first because every well-formed *and* malformed request
  // there costs the same server work.)
  const decision = geocodeLimiter.check(userId);
  if (rateLimitingEnabled() && !decision.allowed) {
    const seconds = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
    return {
      ok: false,
      message: `Too many address searches. Try again in ${seconds}s.`,
    };
  }

  try {
    return { ok: true, results: await geocodeAddress(parsed.data.q) };
  } catch (error) {
    if (error instanceof OutboundPaceSaturatedError) {
      // We declined to ask, and the user is entitled to know that is what
      // happened rather than being told their address does not exist.
      return {
        ok: false,
        message:
          "Address lookup is busy right now. Try again in a few seconds.",
      };
    }
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
