import type { ApiField } from "@/lib/api-reference";

export function FieldList({ title, fields }: { title: string; fields: ApiField[] }) {
  return (
    <section className="mb-8">
      <h2 className="mb-2 text-base font-semibold text-foreground">{title}</h2>
      <dl className="divide-y divide-border border-y border-border">
        {fields.map((field) => (
          <div key={field.name} className="py-3">
            <dt className="flex flex-wrap items-baseline gap-2">
              <code className="font-mono text-[13px] font-semibold text-foreground">{field.name}</code>
              <span className="text-xs text-muted-foreground">{field.type}</span>
              {field.required ? <span className="text-xs font-medium text-danger">required</span> : null}
            </dt>
            <dd className="mt-1 text-sm leading-relaxed text-muted-foreground">{field.description}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
