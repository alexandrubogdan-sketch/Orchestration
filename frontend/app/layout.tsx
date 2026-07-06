import type { Metadata } from "next";
import { Sidebar } from "@/components/layout/sidebar";
import { ThemeProvider } from "@/components/theme-provider";
import "./globals.css";

// Note: intentionally NOT using next/font/google (Geist) — it fetches
// fonts.googleapis.com at build time, which isn't reachable from every
// build environment (this one included). System font stack (see
// globals.css) avoids that network dependency entirely; swap back in
// next/font/google if/when this deploys somewhere with unrestricted
// egress and the exact typeface matters.

export const metadata: Metadata = {
  title: "Payment Orchestrator",
  description: "Internal payment orchestration dashboard",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <body className="flex h-full min-h-screen">
        <ThemeProvider>
          <Sidebar />
          <div className="flex min-w-0 flex-1 flex-col">{children}</div>
        </ThemeProvider>
      </body>
    </html>
  );
}
