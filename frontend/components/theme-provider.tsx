"use client";

import * as React from "react";
import { ThemeProvider as NextThemesProvider } from "next-themes";

/**
 * Thin wrapper around next-themes so app/layout.tsx (a server component)
 * can render it without itself becoming a client component. Uses the
 * `class` strategy — toggles `.dark` on <html>, matched by the
 * `@custom-variant dark` rule in app/globals.css.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      {children}
    </NextThemesProvider>
  );
}
