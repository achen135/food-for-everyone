/**
 * Only allow redirects to same-origin absolute paths. Rejects external URLs,
 * protocol-relative (`//evil.com`) values, and the backslash variants that
 * would otherwise leave the site.
 *
 * Why backslashes matter: per the WHATWG URL spec, a leading `/\` puts the
 * parser into "special authority ignore slashes" state, so a browser resolving
 * a *relative* Location header reads what follows as a hostname --
 * `/\evil.com` becomes `https://evil.com/`. The sign-in Server Action calls
 * `redirect()` with a relative path, so that is exactly the case we hit.
 */
export function safeRedirectPath(
  value: string | null | undefined,
  fallback = "/app",
): string {
  if (typeof value !== "string") return fallback;
  if (!value.startsWith("/")) return fallback;
  if (value.startsWith("//")) return fallback;
  // `/\evil.com`, `/\/evil.com` -- see note above.
  if (value.includes("\\")) return fallback;
  // Browsers strip control characters before parsing, which can reconstitute
  // one of the patterns above (e.g. "/\tevil.com" -> "/evil.com" is benign,
  // but "/<TAB>/evil.com" -> "//evil.com" is not).
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return fallback;
  }
  return value;
}
