"use client";

import {
  ChevronRight,
  CreditCard,
  GripVertical,
  Lock,
  Smartphone,
  Wallet,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { CheckoutMethod, CheckoutMethodType } from "@/lib/types";

const METHOD_ICONS: Record<CheckoutMethodType, React.ComponentType<{ className?: string }>> = {
  card: CreditCard,
  paypal: Wallet,
  apple_pay: Smartphone,
  google_pay: Smartphone,
  venmo: Wallet,
  cash_app: Wallet,
};

/**
 * One row in the Checkout methods list — mirrors the real client's
 * methods-list-item.component.tsx pixel-for-pixel in structure: drag
 * handle (unlocked+enabled) or lock icon (locked/disabled) on the
 * left, method icon + label, a chevron on the right that brightens
 * when selected, a bottom border that appears when selected, and a
 * soft red tint when the method is flagged invalid.
 */
export function CheckoutMethodsListItem({
  method,
  isSelected,
  isInvalid,
  onSelect,
  dragHandleProps,
}: {
  method: CheckoutMethod;
  isSelected: boolean;
  isInvalid: boolean;
  onSelect: () => void;
  /** Spread onto the drag handle only when this row is draggable
   *  (enabled + unlocked) — framer-motion's Reorder.Item supplies
   *  pointer/drag listeners via this prop from the parent. */
  dragHandleProps?: Record<string, unknown>;
}) {
  const Icon = METHOD_ICONS[method.type];
  const isDraggable = method.enabled && !method.locked;

  return (
    <div
      onClick={onSelect}
      className={cn(
        "flex items-center justify-between gap-2 border-b-2 border-transparent px-2 pt-3 pb-[10px] transition-colors hover:cursor-pointer hover:bg-neutral-100 dark:hover:bg-neutral-800",
        isInvalid && "bg-red-100/70 dark:bg-red-950/40",
        isSelected && "border-foreground",
      )}
    >
      <div className="flex items-center gap-3">
        {isDraggable ? (
          <GripVertical
            size={20}
            {...dragHandleProps}
            className="shrink-0 cursor-grab text-neutral-400 active:cursor-grabbing dark:text-neutral-500"
          />
        ) : (
          <Lock size={20} className="shrink-0 text-neutral-400 dark:text-neutral-500" />
        )}

        <div className="flex items-center gap-2">
          <Icon className="size-4 shrink-0 text-muted-foreground" />
          <span
            className={cn(
              "whitespace-nowrap text-sm transition-colors",
              isSelected ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {method.label}
          </span>
        </div>
      </div>

      <ChevronRight
        size={18}
        className={cn(
          "shrink-0 text-neutral-300 transition-colors dark:text-neutral-600",
          isSelected && "text-neutral-600 dark:text-neutral-300",
          isInvalid && "text-neutral-400/70",
        )}
      />
    </div>
  );
}
