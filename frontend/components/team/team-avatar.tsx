import { cn, avatarToneClasses, getInitials } from "@/lib/utils";

export function TeamAvatar({ id, name, className }: { id: string; name: string; className?: string }) {
  return (
    <span
      className={cn(
        "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
        avatarToneClasses(id),
        className,
      )}
    >
      {getInitials(name)}
    </span>
  );
}
