"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { siteUrl } from "@/lib/env";
import { safeRedirectPath } from "@/lib/auth/redirect";
import { createClient } from "@/lib/supabase/server";
import { signInSchema, signUpSchema } from "@/lib/validation/auth";

export type AuthResult = {
  ok: false;
  message: string;
  fieldErrors?: Record<string, string[]>;
};

/** Sign in with email + password. Redirects to `redirectTo` (or /app) on success. */
export async function signIn(input: {
  email: string;
  password: string;
  redirectTo?: string;
}): Promise<AuthResult> {
  const parsed = signInSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      message: "Check the form and try again.",
      fieldErrors: z.flattenError(parsed.error).fieldErrors,
    };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) {
    return { ok: false, message: "Incorrect email or password." };
  }

  revalidatePath("/app", "layout");
  redirect(safeRedirectPath(input.redirectTo));
}

/**
 * Register with email + password. With email confirmation enabled (the Supabase
 * default) no session is created yet, so we route to a "check your inbox" page.
 */
export async function signUp(input: {
  fullName: string;
  email: string;
  password: string;
}): Promise<AuthResult> {
  const parsed = signUpSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      message: "Check the form and try again.",
      fieldErrors: z.flattenError(parsed.error).fieldErrors,
    };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      emailRedirectTo: `${siteUrl()}/auth/confirm?next=/app`,
      data: { full_name: parsed.data.fullName },
    },
  });

  if (error) {
    return { ok: false, message: error.message };
  }

  // A session here means confirmation is disabled on the project; go straight in.
  if (data.session) {
    revalidatePath("/app", "layout");
    redirect("/app");
  }

  redirect(`/verify-email?email=${encodeURIComponent(parsed.data.email)}`);
}

/** Sign out and return to the landing page. */
export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  revalidatePath("/", "layout");
  redirect("/");
}
