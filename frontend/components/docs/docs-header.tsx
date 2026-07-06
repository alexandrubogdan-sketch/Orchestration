import type { ReactNode } from "react";

export function DocsHeader({
  eyebrow,
  title,
  description,
}: {
  eyebrow?: string;
  title: string;
  description?: ReactNode;
}) {
  return (
    <div className="mb-8 border-b border-border pb-6">
      {eyebrow ? (
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-accent">{eyebrow}</div>
      ) : null}
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
      {description ? <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{description}</p> : null}
    </div>
  );
}
