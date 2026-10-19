import { API_RESOURCES, accessFor, describeAccess, type Access } from "@/lib/api-keys";
import { cn } from "@/lib/utils";

const ACCESS_CLASSES: Record<Access, string> = {
  write: "bg-accent text-accent-foreground",
  read: "bg-info-bg text-info",
  none: "bg-neutral-bg text-muted-foreground line-through decoration-muted-foreground/50",
};

const ACCESS_LABEL: Record<Access, string> = { write: "Write", read: "Read", none: "None" };

export function AccessSummary({ scopes }: { scopes: string[] }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-foreground">{describeAccess(scopes)}</span>
      <div className="flex flex-wrap gap-1">
        {API_RESOURCES.map(({ id, label }) => {
          const access = accessFor(scopes, id);
          return (
            <span
              key={id}
              title={`${label}: ${ACCESS_LABEL[access]}`}
              className={cn("rounded px-1.5 py-0.5 text-[11px] font-medium", ACCESS_CLASSES[access])}
            >
              {label} · {ACCESS_LABEL[access]}
            </span>
          );
        })}
      </div>
    </div>
  );
}
