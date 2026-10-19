"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft, Search } from "lucide-react";

import { cn } from "@/lib/utils";
import { ThemeToggle } from "@/components/theme-toggle";
import { LogoMark } from "@/components/brand/logo-mark";
import { MethodBadge } from "@/components/docs/method-badge";
import { API_NAV, GUIDES_NAV, sectionFor, type DocsNavGroup } from "@/components/docs/docs-nav";
import { Toc } from "@/components/docs/toc";

const SECTIONS = [
  { id: "guides", label: "Guides", href: "/docs" },
  { id: "api", label: "API reference", href: "/docs/api" },
] as const;

function filterNav(groups: DocsNavGroup[], query: string): DocsNavGroup[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return groups;
  return groups
    .map((group) => ({ ...group, items: group.items.filter((item) => item.label.toLowerCase().includes(needle)) }))
    .filter((group) => group.items.length > 0);
}

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const section = sectionFor(pathname);
  const isEndpoint = pathname.startsWith("/docs/api/");
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  const groups = useMemo(
    () => (query ? filterNav([...GUIDES_NAV, ...API_NAV], query) : section === "api" ? API_NAV : GUIDES_NAV),
    [query, section],
  );

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const typing = event.target instanceof HTMLElement && ["INPUT", "TEXTAREA"].includes(event.target.tagName);
      if ((event.key === "/" && !typing) || (event.key === "k" && (event.metaKey || event.ctrlKey))) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex min-h-screen flex-1 flex-col bg-background">
      <header className="sticky top-0 z-30 border-b border-border bg-background/90 backdrop-blur">
        <div className="flex h-14 items-center gap-6 px-5">
          <Link href="/docs" className="flex shrink-0 items-center gap-2">
            <LogoMark className="h-7 w-7" />
            <span className="text-sm font-semibold text-foreground">Alpha Payments</span>
            <span className="text-sm text-muted-foreground">Docs</span>
          </Link>
          <nav aria-label="Documentation sections" className="hidden h-full items-stretch gap-5 md:flex">
            {SECTIONS.map((item) => (
              <Link
                key={item.id}
                href={item.href}
                className={cn(
                  "flex items-center border-b-2 text-sm font-medium transition-colors",
                  section === item.id
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <label className="relative hidden sm:block">
              <span className="sr-only">Search the docs</span>
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && setQuery("")}
                placeholder="Search docs"
                className="h-8 w-56 rounded-md border border-border bg-card pl-8 pr-10 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
              />
              <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-border px-1 font-mono text-[10px] text-muted-foreground">
                /
              </kbd>
            </label>
            <Link href="/dashboard" className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground">
              <ArrowLeft className="h-3.5 w-3.5" />
              Dashboard
            </Link>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <div className="flex flex-1">
        <aside className="sticky top-14 hidden h-[calc(100vh-3.5rem)] w-64 shrink-0 overflow-y-auto border-r border-border px-3 py-6 md:block">
          <nav aria-label="Documentation" className="flex flex-col gap-6">
            {groups.length === 0 ? (
              <p className="px-3 text-sm text-muted-foreground">No pages match &ldquo;{query}&rdquo;.</p>
            ) : null}
            {groups.map((group) => (
              <div key={group.title}>
                <div className="px-3 pb-1.5 text-xs font-semibold text-foreground">{group.title}</div>
                <ul className="flex flex-col gap-0.5">
                  {group.items.map((item) => {
                    const isActive = item.href === pathname;
                    return (
                      <li key={item.href}>
                        <Link
                          href={item.href}
                          onClick={() => setQuery("")}
                          aria-current={isActive ? "page" : undefined}
                          className={cn(
                            "flex items-center justify-between gap-2 rounded-md px-3 py-1.5 text-sm transition-colors",
                            isActive
                              ? "bg-accent font-medium text-accent-foreground"
                              : "text-muted-foreground hover:bg-neutral-bg hover:text-foreground",
                          )}
                        >
                          <span className="truncate">{item.label}</span>
                          {item.method ? <MethodBadge method={item.method} className="shrink-0" /> : null}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </nav>
        </aside>

        <div className="min-w-0 flex-1">
          {isEndpoint ? (
            <main className="mx-auto max-w-6xl px-6 py-10 lg:px-10">{children}</main>
          ) : (
            <div className="mx-auto grid max-w-6xl grid-cols-1 gap-10 px-6 py-10 lg:grid-cols-[minmax(0,1fr)_13rem] lg:px-10">
              <main className="min-w-0 max-w-3xl">{children}</main>
              <div className="hidden lg:block">
                <Toc />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
