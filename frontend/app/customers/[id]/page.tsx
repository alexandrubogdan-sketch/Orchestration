import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, CreditCard, Smartphone, Landmark } from "lucide-react";
import { Topbar } from "@/components/layout/topbar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { PaymentStateBadge } from "@/components/status-badge";
import { CustomerPayloadViewer } from "@/components/customers/customer-payload-viewer";
import { getMockCustomerById, getMockPaymentsForCustomer } from "@/lib/mock-data";
import { COUNTRIES } from "@/lib/countries";
import { formatDate, formatDateTime, formatMoney } from "@/lib/utils";
import type { CustomerPaymentMethod, CustomerSubscriptionStatus } from "@/lib/types";

const countryName = (code: string) => COUNTRIES.find((c) => c.code === code)?.name ?? code;

const METHOD_ICON = { card: CreditCard, wallet: Smartphone, bank_transfer: Landmark, apm: Landmark };

const SUBSCRIPTION_STATUS_TONE: Record<CustomerSubscriptionStatus, "success" | "neutral" | "warning" | "danger"> = {
  active: "success",
  trialing: "neutral",
  past_due: "warning",
  canceled: "danger",
};

export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const customer = getMockCustomerById(id);
  if (!customer) notFound();

  const payments = getMockPaymentsForCustomer(customer.id);

  return (
    <>
      <Topbar
        title={`${customer.firstName} ${customer.lastName}`}
        description={`${customer.email} · ${customer.id}`}
      />
      <div className="flex-1 overflow-y-auto p-8">
        <Link
          href="/customers"
          className="mb-6 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to customers
        </Link>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <Card className="lg:col-span-1">
            <CardHeader>
              <CardTitle>Profile</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 text-sm">
              <Row label="Full name">
                {customer.firstName} {customer.lastName}
              </Row>
              <Row label="Email">{customer.email}</Row>
              <Row label="Address">
                <span className="text-right">
                  {customer.address.line1}
                  <br />
                  {customer.address.city}, {customer.address.postalCode}
                </span>
              </Row>
              <Row label="Legal entity">{customer.merchantEntity}</Row>
              <Row label="Location">
                <Badge tone="neutral">{countryName(customer.country)}</Badge>
              </Row>
              <Row label="External ref">
                <span className="font-mono text-xs">{customer.externalRef ?? "—"}</span>
              </Row>
              <Row label="Customer since">{formatDate(customer.createdAt)}</Row>
              <Row label="Plan">{customer.subscription.planName}</Row>
              <Row label="Subscription status">
                <Badge tone={SUBSCRIPTION_STATUS_TONE[customer.subscription.status]}>
                  {customer.subscription.status}
                </Badge>
              </Row>
              <Row label="Total payments">{payments.length}</Row>
            </CardContent>
          </Card>

          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>Payment methods</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {customer.paymentMethods.map((method) => (
                <PaymentMethodRow key={method.id} method={method} />
              ))}
            </CardContent>
          </Card>
        </div>

        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Payments</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <THead>
                <TR>
                  <TH>Payment</TH>
                  <TH>Product</TH>
                  <TH>PSP account</TH>
                  <TH className="text-right">Amount</TH>
                  <TH>Status</TH>
                  <TH>Created</TH>
                </TR>
              </THead>
              <TBody>
                {payments.map((payment) => (
                  <TR key={payment.id}>
                    <TD>
                      <Link
                        href={`/payments/${payment.id}`}
                        className="font-mono text-xs text-accent-foreground hover:underline"
                      >
                        {payment.id}
                      </Link>
                    </TD>
                    <TD className="text-sm text-muted-foreground">{payment.product}</TD>
                    <TD className="text-sm text-muted-foreground">{payment.pspAccount}</TD>
                    <TD className="text-right font-medium">
                      {formatMoney(payment.amountMinorUnits, payment.currency)}
                    </TD>
                    <TD>
                      <PaymentStateBadge state={payment.state} />
                    </TD>
                    <TD className="text-sm text-muted-foreground">
                      {formatDateTime(payment.createdAt)}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            {payments.length === 0 ? (
              <div className="p-8 text-center text-sm text-muted-foreground">
                No payments from this customer yet.
              </div>
            ) : null}
          </CardContent>
        </Card>

        <CustomerPayloadViewer customer={customer} className="mt-6" />
      </div>
    </>
  );
}

function PaymentMethodRow({ method }: { method: CustomerPaymentMethod }) {
  const Icon = METHOD_ICON[method.type];
  return (
    <div className="flex items-center justify-between rounded-lg border border-border p-3">
      <div className="flex items-center gap-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent-foreground">
          <Icon className="h-4 w-4" />
        </div>
        <div>
          {method.type === "card" ? (
            <div className="text-sm font-medium capitalize">
              {method.cardBrand} •••• {method.cardLast4}
            </div>
          ) : method.type === "wallet" ? (
            <div className="text-sm font-medium capitalize">{method.cardBrand?.replace("_", " ")}</div>
          ) : (
            <div className="text-sm font-medium">Bank transfer</div>
          )}
          <div className="text-xs text-muted-foreground">
            {method.pspAccount}
            {method.cardExpMonth && method.cardExpYear
              ? ` · expires ${String(method.cardExpMonth).padStart(2, "0")}/${method.cardExpYear}`
              : null}
          </div>
        </div>
      </div>
      <Badge tone={method.isActive ? "success" : "neutral"}>
        {method.isActive ? "Active" : "Inactive"}
      </Badge>
    </div>
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
