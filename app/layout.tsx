import type { Metadata } from "next";
import { Newsreader, Public_Sans } from "next/font/google";
import "./globals.css";

import { siteUrl } from "@/lib/env";
import { ThemeProvider } from "@/components/theme-provider";

import { Toaster } from "@/components/ui/sonner";

const publicSans = Public_Sans({
  variable: "--font-sans",
  subsets: ["latin"],
  display: "swap",
});

const newsreader = Newsreader({
  variable: "--font-heading",
  subsets: ["latin"],
  display: "swap",
});

const DESCRIPTION =
  "Connects food donors — restaurants, grocers, farms — with food recipients like food banks, shelters, and community fridges through a shared map.";

/**
 * `metadataBase` resolves relative OG/canonical URLs to absolute ones, which
 * link previews require. It comes from `siteUrl()` so it tracks the deployment
 * without another env var — that helper never throws (it falls back to
 * localhost), so it is safe to call at module scope where `metadata` is
 * evaluated.
 */
export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: {
    default: "Food For Everyone",
    template: "%s · Food For Everyone",
  },
  description: DESCRIPTION,
  applicationName: "Food For Everyone",
  openGraph: {
    type: "website",
    siteName: "Food For Everyone",
    title: "Food For Everyone",
    description: DESCRIPTION,
    url: "/",
  },
  twitter: {
    card: "summary_large_image",
    title: "Food For Everyone",
    description: DESCRIPTION,
  },
  // The authenticated app is behind a login and has nothing to index; the
  // landing page is the only thing worth crawling.
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // suppressHydrationWarning: next-themes sets `class` on <html> before React
    // hydrates, so the server and client markup differ here by design.
    <html
      lang="en"
      suppressHydrationWarning
      className={`${publicSans.variable} ${newsreader.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        <ThemeProvider>
          {children}
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
