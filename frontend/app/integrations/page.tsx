"use client";

import { useState } from "react";
import { Plug, Zap } from "lucide-react";
import { Topbar } from "@/components/layout/topbar";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ConnectDialog } from "@/components/integrations/connect-dialog";
import { useIntegrationStore } from "@/lib/integration-store";
import { formatDate } from "@/lib/utils";
import type { Integration } from "@/lib/types";

export default function IntegrationsPage() {
  const integrations = useIntegrationStore((s) => s.integrations);
  const connect = useIntegrationStore((s) => s.connect);
  const disconnect = useIntegrationStore((s) => s.disconnect);
  const [connecting, setConnecting] = useState<Integration | null>(null);

  return (
    <>
      <Topbar
        title="Integrations"
        description="Connect processors — used by Authorize Payment actions in Workflows"
      />
      <div className="flex-1 overflow-y-auto p-8">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {integrations.map((integration) => (
            <Card key={integration.id}>
              <CardContent className="flex flex-col gap-3">
                <div className="flex items-center gap-2">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent">
                    <Plug className="h-4 w-4" />
                  </div>
                  <div>
                    <div className="text-sm font-semibold">{integration.displayName}</div>
                    <Badge tone={integration.status === "connected" ? "success" : "neutral"}>
                      {integration.status === "connected" ? "Connected" : "Not connected"}
                    </Badge>
                  </div>
                </div>

                {integration.status === "connected" ? (
                  <div className="flex flex-col gap-1 text-xs text-muted">
                    <span className="font-mono">{integration.keyPreview}</span>
                    {integration.connectedAt ? (
                      <span>Connected {formatDate(integration.connectedAt)}</span>
                    ) : null}
                  </div>
                ) : (
                  <span className="flex items-center gap-1 text-xs text-muted">
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
          onConnect={(apiKey) => connect(connecting.id, apiKey)}
          onClose={() => setConnecting(null)}
        />
      ) : null}
    </>
  );
}
