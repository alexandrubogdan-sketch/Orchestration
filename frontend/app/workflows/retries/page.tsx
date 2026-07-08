"use client";

import { useEffect, useState } from "react";
import { RotateCcw, Save } from "lucide-react";
import { Topbar } from "@/components/layout/topbar";
import { WorkflowsSubnav } from "@/components/workflow/workflows-subnav";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DunningLadderEditor } from "@/components/retries/dunning-ladder-editor";
import { RetryAttemptsTable } from "@/components/retries/retry-attempts-table";
import { useEnvironmentStore } from "@/lib/environment-store";
import { fetchLiveRetrySettings, putLiveRetrySettings } from "@/lib/live-api";
import { toDunningLadderHours, useRetrySettingsStore } from "@/lib/retry-settings-store";
import { getMockRetryAttempts } from "@/lib/mock-data";

/**
 * Retries tab under Workflows — view/edit the dunning ladder + retry
 * policy that the real Go backend enforces via its `retry_settings`
 * table and GET/PUT /v1/retry-settings API
 * (payment-orchestrator-go/internal/api/retry_settings.go).
 *
 * Updated 2026-07-08: in Live mode this page now calls that real API
 * through this app's own /api/retry-settings proxy
 * (app/api/retry-settings/route.ts, lib/backend-proxy.ts) — GET on
 * mount to populate the ladder/policy shown, PUT from the "Save
 * policy" button — mirroring app/payments/page.tsx and
 * app/customers/page.tsx's established Live-mode pattern (environment
 * check, loading/ready/error state, an inline notice on failure rather
 * than a crash) exactly. Sandbox mode is untouched: it still only ever
 * reads/writes lib/retry-settings-store.ts's local Zustand state, never
 * a network call. This replaces the "NO REAL fetch() CALL HERE" comment
 * that used to live here — that described the whole app before the
 * Sandbox/Live toggle existed, and no longer describes this page.
 */
export default function RetriesPage() {
  const environment = useEnvironmentStore((s) => s.environment);
  const policy = useRetrySettingsStore((s) => s.policy);
  const setMaxAttemptsPerPayment = useRetrySettingsStore((s) => s.setMaxAttemptsPerPayment);
  const setMinSpacingSeconds = useRetrySettingsStore((s) => s.setMinSpacingSeconds);
  const savePolicy = useRetrySettingsStore((s) => s.savePolicy);
  const resetToDefaults = useRetrySettingsStore((s) => s.resetToDefaults);
  const setPolicyFromServer = useRetrySettingsStore((s) => s.setPolicyFromServer);

  const [liveStatus, setLiveStatus] = useState<"loading" | "ready" | "error">("loading");
  const [liveError, setLiveError] = useState("");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "error">("idle");
  const [saveError, setSaveError] = useState("");

  const attempts = getMockRetryAttempts();

  useEffect(() => {
    if (environment !== "live") return;
    let cancelled = false;

    // Deliberately no synchronous setLiveStatus("loading") here — same
    // reasoning as the identical note in app/payments/page.tsx's own
    // effect (avoids flashing back to a loading state on repeated
    // Sandbox <-> Live toggles).
    fetchLiveRetrySettings()
      .then((dto) => {
        if (cancelled) return;
        setPolicyFromServer(dto);
        setLiveStatus("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLiveError(err instanceof Error ? err.message : String(err));
        setLiveStatus("error");
      });

    return () => {
      cancelled = true;
    };
  }, [environment, setPolicyFromServer]);

  async function handleSavePolicy() {
    if (environment !== "live") {
      savePolicy();
      return;
    }

    setSaveStatus("saving");
    setSaveError("");
    try {
      const dto = await putLiveRetrySettings({
        dunningLadderHours: toDunningLadderHours(policy.ladder),
        maxAttemptsPerPayment: policy.maxAttemptsPerPayment,
        minSpacingSeconds: policy.minSpacingSeconds,
      });
      setPolicyFromServer(dto);
      setSaveStatus("idle");
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
      setSaveStatus("error");
    }
  }

  return (
    <>
      <Topbar
        title="Workflows"
        description="Route payments per payment method — one trigger, then conditions and actions"
      />
      <WorkflowsSubnav />
      <div className="flex-1 overflow-y-auto p-8">
        <div className="flex flex-col gap-6">
          {environment === "live" && liveStatus === "loading" ? (
            <p className="text-sm text-muted-foreground">
              Loading retry settings from the live backend…
            </p>
          ) : null}
          {environment === "live" && liveStatus === "error" ? (
            <div className="rounded-lg border border-danger/30 bg-danger-bg p-4 text-sm text-danger">
              Could not load live retry settings: {liveError}
            </div>
          ) : null}

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
            <Button size="sm" onClick={handleSavePolicy} disabled={saveStatus === "saving"}>
              <Save className="h-3.5 w-3.5" /> {saveStatus === "saving" ? "Saving…" : "Save policy"}
            </Button>
            <Button size="sm" variant="outline" onClick={resetToDefaults}>
              <RotateCcw className="h-3.5 w-3.5" /> Reset to defaults
            </Button>
          </div>
          {saveStatus === "error" ? (
            <div className="rounded-lg border border-danger/30 bg-danger-bg p-4 text-sm text-danger">
              Could not save retry settings to the live backend: {saveError}
            </div>
          ) : null}

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
