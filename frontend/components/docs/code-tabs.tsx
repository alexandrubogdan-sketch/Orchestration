"use client";

import { useId, useState } from "react";

import { CopyToClipboardButton } from "@/components/ui/copy-to-clipboard-button";
import { cn } from "@/lib/utils";

export interface CodeSample {
  label: string;
  code: string;
}

export function CodeTabs({ title, samples, className }: { title?: string; samples: CodeSample[]; className?: string }) {
  const [active, setActive] = useState(0);
  const id = useId();
  const current = samples[active] ?? samples[0]!;

  return (
    <div className={cn("overflow-hidden rounded-xl border border-[#262a36] bg-[#12141b] text-[#d7dae3]", className)}>
      <div className="flex items-center gap-1 border-b border-[#262a36] px-2">
        {title ? <span className="px-2 py-2 text-xs font-medium text-[#8b91a3]">{title}</span> : null}
        <div role="tablist" aria-label={title ?? "Code samples"} className="flex flex-1 items-center gap-1">
          {samples.map((sample, index) => (
            <button
              key={sample.label}
              id={`${id}-tab-${index}`}
              role="tab"
              type="button"
              aria-selected={index === active}
              aria-controls={`${id}-panel`}
              onClick={() => setActive(index)}
              className={cn(
                "border-b-2 px-2 py-2 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-[#818cf8]",
                index === active ? "border-[#818cf8] text-white" : "border-transparent text-[#8b91a3] hover:text-white",
              )}
            >
              {sample.label}
            </button>
          ))}
        </div>
        <CopyToClipboardButton text={current.code} className="text-[#8b91a3] hover:text-white" />
      </div>
      <pre id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${active}`} className="max-h-[28rem] overflow-auto px-4 py-3 text-[12.5px] leading-relaxed">
        <code className="font-mono">{current.code}</code>
      </pre>
    </div>
  );
}
