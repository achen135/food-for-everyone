"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ComponentProps } from "react";

/**
 * Applies the `.dark` class that `app/globals.css` has been defining tokens for
 * since M0.
 *
 * `attribute="class"` matches the `@custom-variant dark (&:is(.dark *))` rule in
 * globals.css. `defaultTheme="system"` means the OS preference wins until
 * someone chooses explicitly — a visitor with dark mode on gets a dark page
 * without touching anything.
 *
 * `disableTransitionOnChange` suppresses colour transitions during the swap, so
 * toggling doesn't produce a slow cross-fade of every element on the page.
 */
export function ThemeProvider({
  children,
  ...props
}: ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      {...props}
    >
      {children}
    </NextThemesProvider>
  );
}
