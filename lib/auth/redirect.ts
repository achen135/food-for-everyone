/**
 * Only allow redirects to same-origin absolute paths. Rejects external URLs and
 * protocol-relative (`//evil.com`) values that would otherwise leave the site.
 */
export function safeRedirectPath(
  value: string | null | undefined,
  fallback = "/app",
): string {
  if (typeof value !== "string") return fallback;
  if (!value.startsWith("/") || value.startsWith("//")) return fallback;
  return value;
}
