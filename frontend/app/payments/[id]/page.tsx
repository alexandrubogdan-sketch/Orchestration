import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Topbar } from "@/components/layout/topbar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PaymentStateBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { PaymentTimeline } from "@/components/payments/timeline";
import { getMockPaymentById, generateTimelineFor } from "@/lib/mock-data";
import { formatDateTime, formatMoney } from "@/lib/utils";

export default async function PaymentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const payment = getMockPaymentById(id);
  if (!payment) notFound();

  const timeline = generateTimelineFor(payment);

  return (
    <>
      <Topbar title={payment.id} description={payment.customerEmail} />
      <div className="flex-1 overflow-y-auto p-8">
        <Link
          href="/payments"
          className="mb-6 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to payments
        </Link>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <Card className="lg:col-span-1">
            <CardHeader>
              <CardTitle>Summary</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 text-sm">
              <Row label="Status">
                <PaymentStateBadge state={payment.state} />
              </Row>
              <Row label="Amount">
                {formatMoney(payment.amountMinorUnits, payment.currency)}
              </Row>
              <Row label="Type">
                <Badge tone={payment.citMit === "mit" ? "info" : "neutral"}>
                  {payment.citMit.toUpperCase()}
                </Badge>
              </Row>
              <Row label="Product">{payment.product}</Row>
              <Row label="Legal entity">{payment.merchantEntity}</Row>
              <Row label="PSP account">{payment.pspAccount}</Row>
              <Row label="Customer">{payment.customerEmail}</Row>
              {payment.declineCode ? (
                <Row label="Decline code">
                  <span className="font-mono text-xs text-danger">{payment.declineCode}</span>
                </Row>
              ) : null}
              <Row label="Created">{formatDateTime(payment.createdAt)}</Row>
            </CardContent>
          </Card>

          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>Timeline</CardTitle>
            </CardHeader>
            <CardContent>
              <PaymentTimeline events={timeline} />
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-border pb-2 last:border-0 last:pb-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{children}</span>
    </div>
  );
}
