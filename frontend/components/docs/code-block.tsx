import { cn } from "@/lib/utils";

export interface CodeBlockProps {
  children: string;
  label?: string;
  className?: string;
}

/**
 * Plain, dependency-free code block (no syntax highlighter) for JSON /
 * type shapes / shell snippets in the docs section. Styled with the same
 * card/border tokens as the rest of the app rather than a separate theme.
 */
export function CodeBlock({ children, label, className }: CodeBlockProps) {
  return (
    <div className={cn("overflow-hidden rounded-lg border border-border bg-neutral-bg", className)}>
      {label ? (
        <div className="border-b border-border px-4 py-1.5 text-xs font-medium text-muted-foreground">
          {label}
        </div>
      ) : null}
      <pre className="overflow-x-auto px-4 py-3 text-xs leading-relaxed">
        <code className="font-mono text-foreground">{children}</code>
      </pre>
    </div>
  );
}
