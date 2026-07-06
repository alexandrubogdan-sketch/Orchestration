"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft, BookOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "@/components/theme-toggle";
import { DOCS_NAV } from "@/components/docs/docs-nav";
import { Toc } from "@/components/docs/toc";

/**
 * Docs get their own full-width reading layout instead of nesting inside
 * the main app shell's sidebar — the left nav here is grouped by topic
 * (see components/docs/docs-nav.ts), not by app section, and pages are
 * meant to be read top-to-bottom rather than used as a workspace. It
 * stays visually part of this app: same surface/border/accent tokens,
 * same header treatment as Topbar, same Sidebar-style active-link
 * pattern, just swapped for a "back to app" link instead of the main
 * nav items.
 *
 * Content area is a 2-column CSS grid (content | toc) rather than a flex
 * row with a fixed-width third column: the "on this page" nav's own
 * internal "return null below threshold" logic means that grid column
 * simply collapses to 0 width when there's nothing to show, instead of
 * leaving a blank gap where an empty sidebar would have been.
 */
export default function DocsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="flex h-full min-h-screen flex-1">
      <aside className="flex h-full w-64 shrink-0 flex-col border-r border-border bg-surface">
        <div className="flex items-center gap-2 px-5 py-5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-accent-foreground">
            <BookOpen className="h-4 w-4" />
          </div>
          <div>
            <div className="text-sm font-semibold leading-tight">Documentation</div>
            <div className="text-xs text-muted-foreground">Alpha Payments</div>
          </div>
        </div>

        <nav className="flex flex-1 flex-col gap-5 overflow-y-auto px-3 pb-4">
          {DOCS_NAV.map((group) => (
            <div key={group.title}>
              <div className="px-3 pb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {group.title}
              </div>
              <div className="flex flex-col gap-0.5">
                {group.items.map((item) => {
                  const isActive =
                    item.href === "/docs" ? pathname === "/docs" : pathname.startsWith(item.href);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={cn(
                        "rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                        isActive
                          ? "bg-accent/10 text-accent-foreground"
                          : "text-muted-foreground hover:bg-neutral-bg hover:text-foreground",
                      )}
                    >
                      {item.label}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="flex items-center justify-between gap-2 border-t border-border px-5 py-4 text-xs text-muted-foreground">
          <Link
            href="/dashboard"
            className="flex items-center gap-2 font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to app
          </Link>
          <ThemeToggle />
        </div>
      </aside>

      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid max-w-5xl grid-cols-1 gap-8 px-10 py-10 lg:grid-cols-[minmax(0,1fr)_auto]">
          <main className="min-w-0 max-w-3xl">{children}</main>
          <div className="hidden lg:block">
            <Toc />
          </div>
        </div>
      </div>
    </div>
  );
}
