"use client";

import Link from "next/link";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { RetryOutcomeBadge } from "@/components/status-badge";
import type { RetryAttempt } from "@/lib/types";
import { formatDateTime } from "@/lib/utils";

/**
 * "Recent retry attempts" table — mock data from
 * lib/mock-data.ts#getMockRetryAttempts, rendered the same way
 * components/payments/payments-table.tsx renders its own rows (payment
 * id as a font-mono link to /payments/[id], a Badge-based outcome
 * column, formatDateTime for the timestamp) so this table reads as
 * "the same kind of table" as the rest of the app rather than a
 * one-off.
 */
export function RetryAttemptsTable({ attempts }: { attempts: RetryAttempt[] }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface">
      <Table>
        <THead>
          <TR>
            <TH>Payment</TH>
            <TH>Attempt</TH>
            <TH>PSP account</TH>
            <TH>Outcome</TH>
            <TH>Occurred</TH>
          </TR>
        </THead>
        <TBody>
          {attempts.map((attempt) => (
            <TR key={attempt.id}>
              <TD>
                <Link
                  href={`/payments/${attempt.paymentId}`}
                  className="font-mono text-xs text-accent-foreground hover:underline"
                >
                  {attempt.paymentId}
                </Link>
              </TD>
              <TD className="text-sm text-muted-foreground">#{attempt.attemptNumber}</TD>
              <TD className="text-sm text-muted-foreground">{attempt.pspAccount}</TD>
              <TD>
                <RetryOutcomeBadge outcome={attempt.outcome} />
              </TD>
              <TD className="text-sm text-muted-foreground">{formatDateTime(attempt.occurredAt)}</TD>
            </TR>
          ))}
        </TBody>
      </Table>
      {attempts.length === 0 ? (
        <div className="p-8 text-center text-sm text-muted-foreground">No retry attempts yet.</div>
      ) : null}
    </div>
  );
}
