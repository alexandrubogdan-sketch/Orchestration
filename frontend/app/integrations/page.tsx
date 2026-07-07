"use client";

import { useState } from "react";
import { Plus, Trash2, Zap } from "lucide-react";
import { Topbar } from "@/components/layout/topbar";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ConnectDialog } from "@/components/integrations/connect-dialog";
import { AddIntegrationDialog } from "@/components/integrations/add-integration-dialog";
import { ProcessorIcon } from "@/components/integrations/processor-icons";
import { useIntegrationStore } from "@/lib/integration-store";
import { formatDate } from "@/lib/utils";
import {
  PROCESSOR_CREDENTIAL_FIELDS,
  type Integration,
  type IntegrationMode,
  type ProcessorId,
} from "@/lib/types";

export default function IntegrationsPage() {
  const integrations = useIntegrationStore((s) => s.integrations);
  const connect = useIntegrationStore((s) => s.connect);
  const disconnect = useIntegrationStore((s) => s.disconnect);
  const addIntegration = useIntegrationStore((s) => s.addIntegration);
  const removeIntegration = useIntegrationStore((s) => s.removeIntegration);
  const [connecting, setConnecting] = useState<Integration | null>(null);
  const [addingOpen, setAddingOpen] = useState(false);

  return (
    <>
      <Topbar
        title="Integrations"
        description="Connect processors — used by Authorize Payment actions in Workflows"
      />
      <div className="flex-1 overflow-y-auto p-8">
        <div className="mb-4 flex items-center justify-between">
          <span className="text-sm text-muted-foreground">{integrations.length} integration(s)</span>
          <Button size="sm" onClick={() => setAddingOpen(true)}>
            <Plus className="h-3.5 w-3.5" /> Add integration
          </Button>
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {integrations.map((integration) => (
            <Card key={integration.id} className="group relative">
              <button
                onClick={() => removeIntegration(integration.id)}
                title="Remove integration"
                className="absolute right-3 top-3 text-muted-foreground opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
              <CardContent className="flex flex-col gap-3">
                <div className="flex items-center gap-2">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent-foreground">
                    <ProcessorIcon processor={integration.processor} />
                  </div>
                  <div>
                    <div className="text-sm font-semibold">{integration.displayName}</div>
                    <div className="flex items-center gap-1.5">
                      <Badge tone={integration.status === "connected" ? "success" : "neutral"}>
                        {integration.status === "connected" ? "Connected" : "Not connected"}
                      </Badge>
                      {integration.mode ? <Badge tone="info">{integration.mode}</Badge> : null}
                    </div>
                  </div>
                </div>

                {integration.status === "connected" ? (
                  <div className="flex flex-col gap-1 text-xs text-muted-foreground">
                    {PROCESSOR_CREDENTIAL_FIELDS[integration.processor].map((field) => (
                      <div key={field.key} className="flex justify-between gap-2 font-mono">
                        <span className="text-muted-foreground">{field.label}</span>
                        <span>{integration.credentialPreviews?.[field.key] ?? "—"}</span>
                      </div>
                    ))}
                    {integration.descriptors?.length ? (
                      <div className="flex flex-wrap gap-1 pt-1">
                        {integration.descriptors.map((descriptor) => (
                          <Badge key={descriptor} tone="neutral">
                            {descriptor}
                          </Badge>
                        ))}
                      </div>
                    ) : null}
                    {integration.connectedAt ? (
                      <span>Connected {formatDate(integration.connectedAt)}</span>
                    ) : null}
                  </div>
                ) : (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Zap className="h-3 w-3" /> Available for use in Workflow actions once connected
                  </span>
                )}

                <div className="flex gap-2">
                  {integration.status === "connected" ? (
                    <Button size="sm" variant="outline" onClick={() => disconnect(integration.id)}>
                      Disconnect
                    </Button>
                  ) : (
                    <Button size="sm" onClick={() => setConnecting(integration)}>
                      Connect
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      {connecting ? (
        <ConnectDialog
          integration={connecting}
          onConnect={(mode: IntegrationMode, credentials: Record<string, string>) =>
            connect(connecting.id, connecting.processor, mode, credentials)
          }
          onClose={() => setConnecting(null)}
        />
      ) : null}

      {addingOpen ? (
        <AddIntegrationDialog
          existingDisplayNames={integrations.map((i) => i.displayName)}
          onAdd={(processor: ProcessorId, displayName: string) => addIntegration(processor, displayName)}
          onClose={() => setAddingOpen(false)}
        />
      ) : null}
    </>
  );
}
