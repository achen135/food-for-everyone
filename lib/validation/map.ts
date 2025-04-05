import { z } from "zod";

/**
 * Query-parameter schema for `GET /api/orgs`.
 *
 * Note what is NOT here: a `type` filter. Which side you see is not a
 * preference, it is authorization — donors see recipients and vice versa — so it
 * is derived from the caller's own organization inside `organizations_near()`
 * and can't be influenced from the URL. Spec §7 lists a "type filter"; with
 * exactly two types and a fixed counterparty rule it would always be a no-op.
 */

export const DEFAULT_RADIUS_KM = 25;
export const MIN_RADIUS_KM = 1;
export const MAX_RADIUS_KM = 200;
/** Offered in the UI's radius picker. */
export const RADIUS_OPTIONS_KM = [5, 10, 25, 50, 100, 200] as const;

/** `near=lat,lng` — one param so the pair can't arrive half-set. */
const nearSchema = z
  .string()
  .trim()
  .regex(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/, "Expected `near=lat,lng`")
  .transform((value, ctx) => {
    const [lat, lng] = value.split(",").map(Number);
    if (lat < -90 || lat > 90) {
      ctx.addIssue({ code: "custom", message: "Latitude out of range" });
      return z.NEVER;
    }
    if (lng < -180 || lng > 180) {
      ctx.addIssue({ code: "custom", message: "Longitude out of range" });
      return z.NEVER;
    }
    return { latitude: lat, longitude: lng };
  });

export const orgsQuerySchema = z.object({
  near: nearSchema,
  radiusKm: z.coerce
    .number()
    .min(MIN_RADIUS_KM, `Radius must be at least ${MIN_RADIUS_KM} km`)
    .max(MAX_RADIUS_KM, `Radius must be at most ${MAX_RADIUS_KM} km`)
    .catch(DEFAULT_RADIUS_KM)
    .default(DEFAULT_RADIUS_KM),
  q: z.string().trim().max(200, "Search text is too long").optional(),
});

export type OrgsQuery = z.infer<typeof orgsQuerySchema>;

/** Parse `URLSearchParams` (all strings) into a validated query. */
export function parseOrgsQuery(params: URLSearchParams) {
  return orgsQuerySchema.safeParse({
    near: params.get("near") ?? "",
    radiusKm: params.get("radiusKm") ?? undefined,
    q: params.get("q") ?? undefined,
  });
}
