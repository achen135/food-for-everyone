// Relative, not "@/lib/demo" — this file runs under plain `node
// --experimental-strip-types`, not through Next's bundler, so the tsconfig
// path alias doesn't resolve here (see the module doc below).
import { DEMO_EMAIL } from "../../lib/demo.ts";

/**
 * Seed data for the one read-only demo account (Spec §10 deploy checkpoint) —
 * separate from the 30 fictional organizations in `organizations.ts`, so
 * "~30 orgs on the map" stays an accurate description of what this account
 * sees, not a count that includes itself.
 *
 * The email and password themselves live in `lib/demo.ts`, not here — that
 * module is imported by the app (the sign-in page pre-fills the demo login
 * form with it), and this seed script is never imported by the app in the
 * other direction. Both sides import the same two constants from there.
 *
 * Type is `donor` deliberately: a donor demo sees recipients, and the 14
 * seeded recipients span a wider stretch of the metro (lat range ~0.32°) than
 * the 16 seeded donors (~0.13°), which reads as a fuller map on first look.
 */
export const DEMO_ORGANIZATION = {
  name: "Demo Bistro (read-only)",
  type: "donor" as const,
  description:
    "This is the public read-only demo account — labelled here and in the app so it's never mistaken for a real listing. Posting, claiming, and profile edits are all disabled server-side.",
  email: DEMO_EMAIL,
  phone: null,
  website: null,
  // Chicago Cultural Center — a real, central Loop address, close to the
  // geographic middle of the seeded organizations so the default 50km
  // browse radius comfortably covers all of them.
  address:
    "Chicago Cultural Center, 78, East Washington Street, Loop, Chicago, South Chicago Township, Cook County, Illinois, 60602, United States",
  latitude: 41.8836,
  longitude: -87.627,
  verified: true,
};
