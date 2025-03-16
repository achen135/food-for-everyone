import "server-only";

import type { User } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/server";
import { tracked } from "@/lib/db/instrument";
import type { Profile } from "@/lib/db/types";

/** The current user's profile, or null if not signed in / no row yet. */
export async function getMyProfile(): Promise<Profile | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data, error } = await tracked("profiles.selectByAuthUser", () =>
    supabase.from("profiles").select("*").eq("id", user.id).maybeSingle(),
  );
  if (error) throw error;
  return data;
}

/**
 * Read the profile for an already-authenticated user, creating it on first
 * sight. A Postgres trigger (`handle_new_user`) normally creates the row at
 * sign-up; this is the app-side backstop for users who predate the trigger or
 * whose insert lost a race.
 */
export async function getOrCreateProfile(user: User): Promise<Profile> {
  const supabase = await createClient();

  const { data: existing, error: selectError } = await tracked(
    "profiles.selectById",
    () => supabase.from("profiles").select("*").eq("id", user.id).maybeSingle(),
  );
  if (selectError) throw selectError;
  if (existing) return existing;

  const metadataName =
    typeof user.user_metadata?.full_name === "string"
      ? user.user_metadata.full_name.trim()
      : "";

  const { data: created, error: insertError } = await tracked(
    "profiles.insert",
    () =>
      supabase
        .from("profiles")
        .insert({ id: user.id, full_name: metadataName || null })
        .select("*")
        .single(),
  );

  if (insertError) {
    // 23505 = unique_violation: the signup trigger (or a parallel request) won
    // the race. Re-read the row that now exists.
    if (insertError.code === "23505") {
      const { data: raced, error: rereadError } = await tracked(
        "profiles.selectById.afterRace",
        () => supabase.from("profiles").select("*").eq("id", user.id).single(),
      );
      if (rereadError) throw rereadError;
      return raced;
    }
    throw insertError;
  }

  return created;
}
