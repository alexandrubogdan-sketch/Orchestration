import { cn } from "@/lib/utils";
import type { HttpMethod } from "@/lib/api-reference";

const METHOD_CLASSES: Record<HttpMethod, string> = {
  GET: "bg-success-bg text-success",
  POST: "bg-info-bg text-info",
  DELETE: "bg-danger-bg text-danger",
};

export function MethodBadge({ method, className }: { method: HttpMethod; className?: string }) {
  return (
    <span className={cn("inline-flex rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold", METHOD_CLASSES[method], className)}>
      {method}
    </span>
  );
}
