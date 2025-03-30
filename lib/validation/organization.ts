import { z } from "zod";

/**
 * Organization profile schema. Shared verbatim between the client form
 * (react-hook-form via `zodResolver`) and `saveOrganizationAction`, which
 * re-parses it. Optional text fields are always present as strings from the
 * form; `""` means "not provided" and the Server Action stores it as NULL.
 */

const isEmail = (v: string) => z.email().safeParse(v).success;
const isPhoneish = (v: string) => /^[0-9+().\-\s]{7,40}$/.test(v);
// Accept "example.org", "www.example.org", "https://example.org/x" — anything
// that looks like a host with a dot. The action prepends https:// if missing.
const isUrlish = (v: string) => /^(https?:\/\/)?[^\s.]+\.[^\s]{2,}$/i.test(v);

export const ORGANIZATION_TYPES = ["donor", "recipient"] as const;

export const organizationSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "Organization name is required")
      .max(200, "Keep the name under 200 characters"),
    type: z.enum(ORGANIZATION_TYPES, {
      message: "Choose whether you give or receive food",
    }),
    description: z
      .string()
      .trim()
      .max(2000, "Keep the description under 2000 characters"),
    email: z
      .string()
      .trim()
      .max(320, "That email is too long")
      .refine((v) => v === "" || isEmail(v), "Enter a valid email address"),
    phone: z
      .string()
      .trim()
      .max(40, "That phone number is too long")
      .refine((v) => v === "" || isPhoneish(v), "Enter a valid phone number"),
    website: z
      .string()
      .trim()
      .max(2048, "That URL is too long")
      .refine((v) => v === "" || isUrlish(v), "Enter a valid website URL"),
    address: z
      .string()
      .trim()
      .min(1, "Search for your address and pick a result")
      .max(500, "That address is too long"),
    // Set together by the address search; null on an edit where the address
    // wasn't re-searched (the Server Action then keeps the stored location).
    latitude: z.number().min(-90).max(90).nullable(),
    longitude: z.number().min(-180).max(180).nullable(),
  })
  .refine((v) => v.email !== "" || v.phone !== "", {
    message: "Add an email or a phone number so counterparties can reach you",
    path: ["email"],
  });

export type OrganizationInput = z.infer<typeof organizationSchema>;

export const geocodeQuerySchema = z.object({
  q: z
    .string()
    .trim()
    .min(3, "Type at least 3 characters")
    .max(200, "That's too long to search"),
});

/**
 * On an edit, `latitude`/`longitude` only arrive when the user re-ran the
 * address search. If the address text changed without them, the stored point
 * would still be the old one — the M3 map pin would sit somewhere other than the
 * address shown next to it. The form makes this impossible (address is
 * display-only, set only by the search dialog), but the Server Action is the
 * real trust boundary, so it checks too.
 */
export function needsFreshGeocode(args: {
  storedAddress: string | null;
  inputAddress: string;
  latitude: number | null;
  longitude: number | null;
}): boolean {
  if (args.latitude !== null && args.longitude !== null) return false;
  return (args.storedAddress ?? "") !== args.inputAddress;
}
