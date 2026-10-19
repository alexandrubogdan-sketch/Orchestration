import type { ReactNode } from "react";

export function DocSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="mb-12 scroll-mt-24">
      <h2 id={id} className="mb-3 scroll-mt-24 text-xl font-semibold tracking-tight text-foreground">
        {title}
      </h2>
      <div className="flex flex-col gap-4 text-[15px] leading-relaxed text-muted-foreground">{children}</div>
    </section>
  );
}

export function InlineCode({ children }: { children: ReactNode }) {
  return <code className="rounded bg-neutral-bg px-1 py-0.5 font-mono text-[13px] text-foreground">{children}</code>;
}

export function Steps({ children }: { children: ReactNode }) {
  return <ol className="flex flex-col gap-10 border-l border-border pl-8 [counter-reset:step]">{children}</ol>;
}

export function Step({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <li className="relative [counter-increment:step] before:absolute before:-left-[2.85rem] before:top-0 before:flex before:h-7 before:w-7 before:items-center before:justify-center before:rounded-full before:border before:border-border before:bg-card before:text-xs before:font-semibold before:text-foreground before:content-[counter(step)]">
      <h2 id={id} className="mb-3 scroll-mt-24 text-lg font-semibold text-foreground">
        {title}
      </h2>
      <div className="flex flex-col gap-4 text-[15px] leading-relaxed text-muted-foreground">{children}</div>
    </li>
  );
}
