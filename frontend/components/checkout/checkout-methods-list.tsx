"use client";

import { Reorder } from "framer-motion";
import { isCheckoutMethodInvalid } from "@/lib/mock-data";
import { useCheckoutStore } from "@/lib/checkout-store";
import { CheckoutMethodsListItem } from "./methods-list-item";

/**
 * Active / Inactive methods list — structurally mirrors the real
 * client's checkout-methods-list.component.tsx: an "Active" section
 * with a drag-to-reorder framer-motion `Reorder.Group` for the
 * unlocked active methods, any locked active methods (Card) rendered
 * statically below (not reorderable), then an "Inactive" section (or
 * a muted empty-state line).
 *
 * Dependency choice: framer-motion's `Reorder` was NOT already a
 * dependency in this frontend — added it (small, well-maintained, and
 * it's exactly the drag-reorder primitive the real client itself
 * uses) rather than hand-rolling an equivalent pointer-based reorder
 * interaction, since matching the real interaction feel 1:1 was an
 * explicit goal here.
 */
export function CheckoutMethodsList() {
  const methods = useCheckoutStore((s) => s.methods);
  const selectedMethodId = useCheckoutStore((s) => s.selectedMethodId);
  const selectMethod = useCheckoutStore((s) => s.selectMethod);
  const reorderActiveMethods = useCheckoutStore((s) => s.reorderActiveMethods);

  const activeUnlocked = methods.filter((m) => m.enabled && !m.locked);
  const activeLocked = methods.filter((m) => m.enabled && m.locked);
  const inactive = methods.filter((m) => !m.enabled);

  return (
    <div className="flex w-full flex-col gap-4 md:min-w-[190px]">
      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium text-muted-foreground">Active</p>

        <div className="flex flex-col">
          <Reorder.Group
            axis="y"
            values={activeUnlocked}
            onReorder={(reordered) => reorderActiveMethods(reordered.map((m) => m.id))}
            className="flex flex-col"
          >
            {activeUnlocked.map((method) => (
              <Reorder.Item key={method.id} value={method}>
                <CheckoutMethodsListItem
                  method={method}
                  isSelected={selectedMethodId === method.id}
                  isInvalid={isCheckoutMethodInvalid(method)}
                  onSelect={() => selectMethod(method.id)}
                />
              </Reorder.Item>
            ))}
          </Reorder.Group>

          {activeLocked.length > 0 && (
            <div className="flex flex-col">
              {activeLocked.map((method) => (
                <CheckoutMethodsListItem
                  key={method.id}
                  method={method}
                  isSelected={selectedMethodId === method.id}
                  isInvalid={isCheckoutMethodInvalid(method)}
                  onSelect={() => selectMethod(method.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium text-muted-foreground">Inactive</p>

        <div className="flex flex-col">
          {inactive.length > 0 ? (
            inactive.map((method) => (
              <CheckoutMethodsListItem
                key={method.id}
                method={method}
                isSelected={selectedMethodId === method.id}
                isInvalid={isCheckoutMethodInvalid(method)}
                onSelect={() => selectMethod(method.id)}
              />
            ))
          ) : (
            <p className="text-sm text-muted-foreground">No inactive methods</p>
          )}
        </div>
      </div>
    </div>
  );
}
