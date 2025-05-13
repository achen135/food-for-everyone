"use client";

import { useTheme } from "next-themes";
import { MoonIcon, SunIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Light/dark toggle.
 *
 * The usual recipe for this gates rendering on a `mounted` flag set in an
 * effect, because the server can't know the visitor's theme and rendering the
 * wrong icon would mismatch on hydration. We don't, for two reasons: it makes
 * the button pop in after hydration, and `setState` inside an effect trips
 * `react-hooks/set-state-in-effect` (cascading renders).
 *
 * Instead both icons are always rendered and CSS picks one, keyed off the same
 * `.dark` class on `<html>` that next-themes toggles. The server and client
 * emit identical markup, so there is nothing to mismatch, and the correct icon
 * is showing before React has hydrated at all.
 *
 * The current theme is read from the DOM in the click handler rather than from
 * `resolvedTheme` during render — on the very first render `resolvedTheme` is
 * still undefined, which would make the first click a no-op for anyone whose
 * system preference is already dark.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { setTheme } = useTheme();

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className={className}
      aria-label="Switch between light and dark theme"
      onClick={() =>
        setTheme(
          document.documentElement.classList.contains("dark")
            ? "light"
            : "dark",
        )
      }
    >
      <SunIcon className="hidden dark:block" aria-hidden="true" />
      <MoonIcon className="block dark:hidden" aria-hidden="true" />
    </Button>
  );
}
