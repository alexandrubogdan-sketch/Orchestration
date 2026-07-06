"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useWorkflowStore } from "@/lib/workflow-store";
import { PAYMENT_METHOD_LABELS, PAYMENT_METHOD_TYPES, type PaymentMethodType } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * docs.paynext.com/guides/platform/workflows: "Each payment method can
 * only have one workflow. To route Cards and Apple Pay differently,
 * create separate workflows — one for each payment method." Payment
 * methods that already have a workflow are disabled here to match.
 */
export function CreateWorkflowDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const workflows = useWorkflowStore((s) => s.workflows);
  const createWorkflow = useWorkflowStore((s) => s.createWorkflow);
  const usedMethods = new Set(workflows.map((w) => w.paymentMethod));

  const [paymentMethod, setPaymentMethod] = useState<PaymentMethodType | null>(null);
  const [name, setName] = useState("");

  const canCreate = paymentMethod !== null && name.trim().length > 0;

  function handleCreate() {
    if (!canCreate || !paymentMethod) return;
    const id = createWorkflow(paymentMethod, name.trim());
    onClose();
    router.push(`/workflows/${id}`);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-8">
      <div className="w-full max-w-md rounded-xl bg-surface shadow-xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold">Create workflow</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex flex-col gap-4 p-5">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Workflow name</span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Cards — primary routing"
            />
          </label>

          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Payment method</span>
            <span className="text-xs text-muted-foreground">
              Each payment method can have only one workflow.
            </span>
            <div className="flex flex-col gap-2">
              {PAYMENT_METHOD_TYPES.map((method) => {
                const disabled = usedMethods.has(method);
                return (
                  <button
                    key={method}
                    disabled={disabled}
                    onClick={() => setPaymentMethod(method)}
                    className={cn(
                      "flex items-center justify-between rounded-lg border px-3 py-2 text-sm transition-colors",
                      disabled
                        ? "cursor-not-allowed border-border bg-neutral-bg text-muted-foreground"
                        : paymentMethod === method
                          ? "border-accent-foreground bg-accent/10 text-accent-foreground"
                          : "border-border hover:border-accent",
                    )}
                  >
                    {PAYMENT_METHOD_LABELS[method]}
                    {disabled ? <span className="text-xs">already has a workflow</span> : null}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <Button size="sm" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={!canCreate} onClick={handleCreate}>
            Create workflow
          </Button>
        </div>
      </div>
    </div>
  );
}
