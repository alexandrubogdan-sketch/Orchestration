"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * Small in-page tab nav for the Workflows section (Workflows list |
 * Retries), rendered above the page content on both
 * app/workflows/page.tsx and app/workflows/retries/page.tsx. This
 * section had no existing sub-tab pattern to follow (Workflows was
 * previously a flat list page -> [id] detail page, with no
 * intermediate tab level, and the main Sidebar's own NAV_ITEMS list is
 * one level, one link per top-level section — see
 * components/layout/sidebar.tsx). Rather than invent a heavier
 * shadcn-style Tabs primitive for this one section, this mirrors the
 * SIDEBAR's own active-link styling (bg-accent/10 + text-accent-foreground
 * for the active item, muted-foreground + hover otherwise) at a
 * smaller scale, so a new user recognizes it as "the same kind of
 * navigation" rather than a one-off widget.
 */
export function WorkflowsSubnav() {
  const pathname = usePathname();
  const items = [
    { href: "/workflows", label: "Workflows" },
    { href: "/workflows/retries", label: "Retries" },
  ];

  return (
    <div className="flex items-center gap-1 border-b border-border bg-surface px-8 pt-3">
      {items.map((item) => {
        const isActive =
          item.href === "/workflows" ? pathname === "/workflows" : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "rounded-t-md px-3 py-2 text-sm font-medium transition-colors",
              isActive
                ? "border-b-2 border-accent-foreground text-accent-foreground"
                : "border-b-2 border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </div>
  );
}
