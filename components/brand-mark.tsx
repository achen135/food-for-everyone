/**
 * The wordmark's pin glyph. Shared by the landing header/footer
 * (`app/page.tsx`) and the auth layout (`app/(auth)/layout.tsx`), which is why
 * it lives here rather than beside either one.
 *
 * `aria-hidden` on purpose: every use so far pairs it with the visible words
 * "Food For Everyone", and a decorative glyph that also announced itself would
 * make the link read as its own name twice.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 28 28"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <path
        d="M14 1.5c-4.7 0-8.5 3.8-8.5 8.5 0 6 7.4 14.7 8 15.4a.7.7 0 0 0 1 0c.6-.7 8-9.4 8-15.4 0-4.7-3.8-8.5-8.5-8.5Z"
        fill="currentColor"
      />
    </svg>
  );
}
