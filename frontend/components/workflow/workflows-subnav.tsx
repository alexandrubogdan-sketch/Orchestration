"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

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
