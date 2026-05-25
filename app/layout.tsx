import type { Metadata } from "next";
import { Inter } from "next/font/google";

import { AppShell } from "@/components/AppShell";
import { ThemeProvider, themeBootstrapScript } from "@/components/ThemeProvider";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: "VoxHorizon Marketing Control Panel",
  description:
    "Internal marketing operations dashboard for briefs, creatives, launches, and the audit trail.",
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <head>
        {/*
         * Apply the persisted theme before first paint to avoid a flash of
         * the wrong theme. Runs synchronously ahead of hydration; the
         * ThemeProvider then takes over.
         */}
        <script
          dangerouslySetInnerHTML={{ __html: themeBootstrapScript }}
          suppressHydrationWarning
        />
      </head>
      <body className="min-h-dvh font-sans">
        <ThemeProvider defaultTheme="dark">
          <TooltipProvider delayDuration={300}>
            <AppShell>{children}</AppShell>
            <Toaster />
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
