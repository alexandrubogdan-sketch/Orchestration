export function Topbar({ title, description }: { title: string; description?: string }) {
  return (
    <header className="flex items-center justify-between border-b border-border bg-surface px-8 py-5">
      <div>
        <h1 className="text-lg font-semibold">{title}</h1>
        {description ? <p className="mt-0.5 text-sm text-muted">{description}</p> : null}
      </div>
    </header>
  );
}
