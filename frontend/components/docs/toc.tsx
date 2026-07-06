"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

interface TocHeading {
  id: string;
  text: string;
  level: 2 | 3;
}

const MIN_HEADINGS = 3;

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

/**
 * Right-hand "On this page" table of contents for the /docs section.
 *
 * Headings are derived at runtime from the rendered content
 * (`document.querySelectorAll('h2, h3')`) rather than passed in as props,
 * since docs pages are static JSX and duplicating a heading list per page
 * would just be another thing to keep in sync. Any heading missing a
 * stable `id` gets one assigned (slugified from its text, de-duplicated)
 * so anchor links and scroll-spy both have something to target.
 *
 * Scroll-spy uses IntersectionObserver instead of a scroll listener —
 * cheaper, and avoids re-computing bounding boxes on every scroll tick.
 *
 * Renders nothing (returns null) when the page has fewer than
 * MIN_HEADINGS headings, so short pages don't show a near-empty sidebar.
 */
export function Toc() {
  const pathname = usePathname();
  const [headings, setHeadings] = useState<TocHeading[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);

  useEffect(() => {
    const nodes = Array.from(document.querySelectorAll<HTMLHeadingElement>("main h2, main h3"));

    const seen = new Set<string>();
    const derived: TocHeading[] = nodes.map((node) => {
      let id = node.id;
      if (!id) {
        const base = slugify(node.textContent ?? "");
        id = base || "section";
        let suffix = 1;
        while (seen.has(id)) {
          id = `${base}-${suffix}`;
          suffix += 1;
        }
        node.id = id;
      }
      seen.add(id);
      return {
        id,
        text: node.textContent ?? "",
        level: node.tagName === "H3" ? 3 : 2,
      };
    });

    // Deferred (rather than called synchronously in the effect body) since
    // this state is derived from a DOM measurement taken after mount, not
    // from a prop/state change React already knows about — queuing it as a
    // microtask avoids the cascading-render footgun the "set state in
    // effect" rule is guarding against while still updating before paint.
    queueMicrotask(() => {
      setHeadings(derived);
      setActiveId(derived[0]?.id ?? null);
    });

    if (nodes.length === 0) {
      return;
    }

    observerRef.current?.disconnect();
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((entry) => entry.isIntersecting);
        if (visible.length > 0) {
          const topMost = visible.reduce((a, b) => (a.boundingClientRect.top < b.boundingClientRect.top ? a : b));
          setActiveId(topMost.target.id);
        }
      },
      {
        rootMargin: "-96px 0px -70% 0px",
        threshold: 0,
      },
    );

    nodes.forEach((node) => observer.observe(node));
    observerRef.current = observer;

    return () => observer.disconnect();
  }, [pathname]);

  if (headings.length < MIN_HEADINGS) {
    return null;
  }

  return (
    <nav aria-label="On this page" className="sticky top-10 max-h-[calc(100vh-5rem)] overflow-y-auto pl-6">
      <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        On this page
      </div>
      <ul className="space-y-1.5 border-l border-border pl-4 text-sm">
        {headings.map((heading) => {
          const isActive = heading.id === activeId;
          return (
            <li key={heading.id} className={heading.level === 3 ? "pl-3" : undefined}>
              <a
                href={`#${heading.id}`}
                className={cn(
                  "block truncate transition-colors",
                  isActive
                    ? "font-medium text-accent-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {heading.text}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
