import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { HapticsProvider } from "@/components/haptics-provider";
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
        {/* Streamdown code-block token colors — Tailwind v4 scanner cannot extract
            classes with nested var()/commas, so we apply the token colors via plain CSS. */}
        <style
          dangerouslySetInnerHTML={{
            __html: [
              '[data-streamdown="code-block-body"] span[style]{color:var(--sdm-c,inherit)}',
              '.dark [data-streamdown="code-block-body"] span[style]{color:var(--shiki-dark,var(--sdm-c,inherit))}',
            ].join("\n"),
          }}
        />
        <TooltipProvider delayDuration={300} skipDelayDuration={100}>
          <HapticsProvider>
            <a
              href="#main-content"
              className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:bg-card focus:text-foreground focus:px-3 focus:py-2 focus:rounded-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              Skip to main content
            </a>
            <nav aria-label="Main" className="z-50 hidden h-11 shrink-0 items-center gap-6 border-b border-border/90 bg-background/95 px-6 font-sans backdrop-blur-sm md:flex">
              <Link
                href="/"
                className="rounded-md px-1.5 py-1 text-label font-semibold tracking-tight text-foreground no-underline transition-colors duration-fast hover:bg-accent/55"
              >
                AI2
              </Link>
              <Link
                href="/"
                className="rounded-md px-1.5 py-1 text-label font-medium text-muted-foreground no-underline transition-colors duration-fast hover:bg-accent/55 hover:text-foreground"
              >
                Threads
              </Link>
              <Link
                href="/portfolio"
                className="rounded-md px-1.5 py-1 text-label font-medium text-muted-foreground no-underline transition-colors duration-fast hover:bg-accent/55 hover:text-foreground"
              >
                Portfolio
              </Link>
            </nav>
            <main id="main-content" className="h-full overflow-hidden md:h-[calc(100%-44px)]">
              {children}
            </main>
            <Toaster position="top-right" richColors closeButton />
          </HapticsProvider>
        </TooltipProvider>
      </body>
    </html>
  );
}
