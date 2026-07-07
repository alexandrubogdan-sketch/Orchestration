import type { ReactNode } from "react";
import { Plug } from "lucide-react";
import type { ProcessorId } from "@/lib/types";

/** Simplified PayPal "double P" mark in PayPal's two brand blues. Kept as
 *  a tiny inline SVG rather than pulling in an icon package — this is the
 *  first per-processor icon in the codebase, so it's intentionally minimal
 *  and self-contained rather than a general icon system. */
function PayPalMark() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
      <path
        fill="#003087"
        d="M8.5 4h5.6c2.4 0 4 1.5 3.6 3.9-.5 3.1-2.7 4.6-5.5 4.6H10l-.9 5.5H6.3L8.5 4Z"
      />
      <path
        fill="#009cde"
        d="M10.8 6.3h5.6c1.5 0 2.5.5 2.8 1.6.4 1.9-.9 4.6-3.9 4.6h-2.2l-.8 5.2H9.5l1.3-11.4Z"
      />
    </svg>
  );
}

/** Per-processor icon overrides. Only PayPal has a distinct mark today —
 *  stripe/solidgate fall back to the generic Plug icon via PROCESSOR_ICONS
 *  not having an entry for them. Deliberately not retrofitting distinct
 *  icons for the other processors here; out of scope for this change. */
export const PROCESSOR_ICONS: Partial<Record<ProcessorId, ReactNode>> = {
  paypal: <PayPalMark />,
};

export function ProcessorIcon({ processor }: { processor: ProcessorId }) {
  return <>{PROCESSOR_ICONS[processor] ?? <Plug className="h-4 w-4" />}</>;
}
