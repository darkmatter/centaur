import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI2",
  other: {
    "apple-mobile-web-app-capable": "yes",
    "apple-mobile-web-app-status-bar-style": "black-translucent",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "overlays-content",
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`dark ${GeistSans.variable} ${GeistMono.variable}`}>
      <body suppressHydrationWarning className="m-0 bg-background text-foreground antialiased font-sans fixed inset-0 overflow-hidden">
        <TooltipProvider delayDuration={300} skipDelayDuration={100}>
          <a
            href="#main-content"
            className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:bg-card focus:text-foreground focus:px-3 focus:py-2 focus:rounded-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            Skip to main content
          </a>
          <nav aria-label="Main" className="hidden md:flex items-center gap-6 px-6 py-2.5 border-b border-border bg-background/95 backdrop-blur-sm font-sans z-50 shrink-0">
            <Link
              href="/"
              className="text-foreground no-underline font-semibold text-[13px] tracking-tight rounded-sm"
            >
              AI2
            </Link>
            <Link
              href="/"
              className="text-muted-foreground no-underline text-[13px] font-medium hover:text-foreground transition-colors rounded-sm"
            >
              Threads
            </Link>
          </nav>
          <main id="main-content" className="h-full md:h-[calc(100%-41px)] overflow-hidden">
            {children}
          </main>
          <Toaster position="top-right" richColors closeButton />
        </TooltipProvider>
      </body>
    </html>
  );
}
