"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, Download, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PAYMENT_METHOD_LABELS } from "@/lib/types";
import { useWorkflowStore } from "@/lib/workflow-store";

export function BuilderToolbar({ workflowId }: { workflowId: string }) {
  const workflow = useWorkflowStore((s) => s.workflows.find((w) => w.id === workflowId));
  const togglePublish = useWorkflowStore((s) => s.togglePublish);
  const [jsonOpen, setJsonOpen] = useState(false);

  if (!workflow) return null;

  return (
    <>
      <div className="flex items-center gap-3 border-b border-border bg-surface px-6 py-3">
        <Link href="/workflows" className="text-muted hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div>
          <div className="text-sm font-semibold">{workflow.name}</div>
          <div className="text-xs text-muted">{PAYMENT_METHOD_LABELS[workflow.paymentMethod]}</div>
        </div>
        <Badge tone={workflow.state === "published" ? "success" : "neutral"}>{workflow.state}</Badge>

        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => togglePublish(workflow.id)}>
            {workflow.state === "published" ? "Unpublish" : "Publish"}
          </Button>
          <Button size="sm" onClick={() => setJsonOpen(true)}>
            <Download className="h-3.5 w-3.5" /> Export config
          </Button>
        </div>
      </div>
      {jsonOpen ? <ExportPanel json={JSON.stringify(workflow, null, 2)} onClose={() => setJsonOpen(false)} /> : null}
    </>
  );
}

function ExportPanel({ json, onClose }: { json: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-8">
      <div className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl bg-surface shadow-xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold">Workflow configuration (JSON)</h2>
          <button onClick={onClose} className="text-muted hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
        <pre className="flex-1 overflow-auto bg-neutral-bg p-5 font-mono text-xs leading-relaxed">
          {json}
        </pre>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <Button size="sm" variant="outline" onClick={() => void navigator.clipboard.writeText(json)}>
            Copy to clipboard
          </Button>
          <Button size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}
