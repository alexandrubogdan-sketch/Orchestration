"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  CreditCard,
  Users,
  Repeat,
  Plug,
  Workflow,
  Building2,
  ShieldAlert,
  BookOpen,
  Users2,
  PanelsTopLeft,
  Bot,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "@/components/theme-toggle";
import { LogoMark } from "@/components/brand/logo-mark";
import { EnvironmentToggle } from "@/components/layout/environment-toggle";

const NAV_ITEMS = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/payments", label: "Payments", icon: CreditCard },
  { href: "/customers", label: "Customers", icon: Users },
  { href: "/checkout", label: "Checkout", icon: PanelsTopLeft },
  { href: "/plans", label: "Plans", icon: Repeat },
  { href: "/integrations", label: "Integrations", icon: Plug },
  { href: "/team", label: "Team", icon: Users2 },
  { href: "/workflows", label: "Workflows", icon: Workflow },
  { href: "/risk-monitoring", label: "Risk Monitoring", icon: ShieldAlert },
  { href: "/agents", label: "AI Agents", icon: Bot },
  { href: "/docs", label: "Docs", icon: BookOpen },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r border-border bg-surface">
      <div className="flex items-center gap-2 px-5 py-5">
        <LogoMark className="h-8 w-8 shrink-0" />
        <div>
          <div className="text-sm font-semibold leading-tight">Alpha Payments</div>
          <div className="text-xs text-muted-foreground">ProgressPartners LLC</div>
        </div>
      </div>

      <nav className="flex flex-1 flex-col gap-1 px-3">
        {NAV_ITEMS.map((item) => {
          const isActive = pathname.startsWith(item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-accent/10 text-accent-foreground"
                  : "text-muted-foreground hover:bg-neutral-bg hover:text-foreground",
              )}
            >
              <Icon className="h-4 w-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="flex items-center justify-between gap-2 border-t border-border px-5 py-3">
        <span className="text-xs font-semibold text-foreground">Progress Partners</span>
        <EnvironmentToggle />
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-border px-5 py-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-2">
          <Building2 className="h-4 w-4" />
          US-LLC &amp; EU-BV
        </span>
        <ThemeToggle />
      </div>
    </aside>
  );
}
