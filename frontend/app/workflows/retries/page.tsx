"use client";

import { RotateCcw, Save } from "lucide-react";
import { Topbar } from "@/components/layout/topbar";
import { WorkflowsSubnav } from "@/components/workflow/workflows-subnav";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DunningLadderEditor } from "@/components/retries/dunning-ladder-editor";
import { RetryAttemptsTable } from "@/components/retries/retry-attempts-table";
import { useRetrySettingsStore } from "@/lib/retry-settings-store";
import { getMockRetryAttempts } from "@/lib/mock-data";

/**
 * Retries tab under Workflows — view/edit the dunning ladder + retry
 * policy that the real Go backend enforces via its `retry_settings`
 * table and GET/PUT /v1/retry-settings API
 * (payment-orchestrator-go/internal/api/retry_settings.go).
 *
 * NO REAL fetch() CALL HERE, matching this entire frontend's
 * established mock-data-driven convention (see this repo's README/
 * lib/mock-data.ts's own top doc comment — every page renders against
 * Zustand + generated fixtures, never a live API). "Saving" the
 * ladder/policy below only updates lib/retry-settings-store.ts's local
 * Zustand state for the current session — but that store's actions are
 * structured so wiring in a real `PUT /v1/retry-settings` call later is
 * a one-line change; see retry-settings-store.ts's savePolicy doc
 * comment for exactly what that line would look like.
 */
export default function RetriesPage() {
  const policy = useRetrySettingsStore((s) => s.policy);
  const setMaxAttemptsPerPayment = useRetrySettingsStore((s) => s.setMaxAttemptsPerPayment);
  const setMinSpacingSeconds = useRetrySettingsStore((s) => s.setMinSpacingSeconds);
  const savePolicy = useRetrySettingsStore((s) => s.savePolicy);
  const resetToDefaults = useRetrySettingsStore((s) => s.resetToDefaults);

  const attempts = getMockRetryAttempts();

  return (
    <>
      <Topbar
        title="Workflows"
        description="Route payments per payment method — one trigger, then conditions and actions"
      />
      <WorkflowsSubnav />
      <div className="flex-1 overflow-y-auto p-8">
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Dunning ladder</CardTitle>
              <CardDescription>
                After a subscription renewal fails, wait the given number of hours and try again —
                in order, up to the last step below. Defaults to 24h / 72h / 168h, matching the
                real backend&apos;s own default.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <DunningLadderEditor />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Retry policy</CardTitle>
              <CardDescription>
                Governs same-instrument retries within a single payment&apos;s own attempt sequence
                (independent of the dunning ladder above).
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-6">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="max-attempts">Max attempts per payment</Label>
                  <Input
                    id="max-attempts"
                    type="number"
                    min={1}
                    value={policy.maxAttemptsPerPayment}
                    onChange={(e) => setMaxAttemptsPerPayment(Number.parseInt(e.target.value, 10) || 1)}
                    className="w-40"
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="min-spacing">Minimum spacing (seconds)</Label>
                  <Input
                    id="min-spacing"
                    type="number"
                    min={0}
                    value={policy.minSpacingSeconds}
                    onChange={(e) => setMinSpacingSeconds(Number.parseInt(e.target.value, 10) || 0)}
                    className="w-40"
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="flex items-center gap-2">
            <Button size="sm" onClick={savePolicy}>
              <Save className="h-3.5 w-3.5" /> Save policy
            </Button>
            <Button size="sm" variant="outline" onClick={resetToDefaults}>
              <RotateCcw className="h-3.5 w-3.5" /> Reset to defaults
            </Button>
          </div>

          <div className="flex flex-col gap-3">
            <div>
              <h2 className="text-sm font-semibold">Recent retry attempts</h2>
              <p className="text-xs text-muted-foreground">
                {attempts.length} attempt(s) across recent dunning runs
              </p>
            </div>
            <RetryAttemptsTable attempts={attempts} />
          </div>
        </div>
      </div>
    </>
  );
}
