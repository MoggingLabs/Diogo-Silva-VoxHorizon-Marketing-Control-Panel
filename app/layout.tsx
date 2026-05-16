import type { Metadata } from "next";
import { Inter } from "next/font/google";

import { AppShell } from "@/components/AppShell";

import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: "VoxHorizon Marketing Control Panel",
  description:
    "Internal marketing operations dashboard — briefs, creatives, launches, and audit trail.",
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="min-h-dvh font-sans">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
