import type { ReactNode } from "react";

export function DocsHeader({ eyebrow, title, description }: { eyebrow?: string; title: string; description?: ReactNode }) {
  return (
    <div className="mb-10">
      {eyebrow ? <p className="mb-2 text-sm font-medium text-primary">{eyebrow}</p> : null}
      <h1 className="text-3xl font-semibold tracking-tight text-foreground">{title}</h1>
      {description ? <p className="mt-3 max-w-prose text-[15px] leading-relaxed text-muted-foreground">{description}</p> : null}
    </div>
  );
}
