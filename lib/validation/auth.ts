import { z } from "zod";

/**
 * Auth form schemas. Shared verbatim between the client form (react-hook-form
 * via `zodResolver`) and the Server Action, which re-parses as defense in depth.
 */

const email = z
  .string()
  .trim()
  .min(1, "Email is required")
  .pipe(z.email("Enter a valid email address"));

export const signInSchema = z.object({
  email,
  password: z.string().min(1, "Password is required"),
});
export type SignInInput = z.infer<typeof signInSchema>;

export const signUpSchema = z.object({
  fullName: z
    .string()
    .trim()
    .min(1, "Your name is required")
    .max(120, "That name is too long"),
  email,
  // Supabase caps bcrypt input at 72 bytes.
  password: z
    .string()
    .min(8, "Use at least 8 characters")
    .max(72, "Use at most 72 characters"),
});
export type SignUpInput = z.infer<typeof signUpSchema>;
