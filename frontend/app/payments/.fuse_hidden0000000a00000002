import { Topbar } from "@/components/layout/topbar";
import { PaymentsTable } from "@/components/payments/payments-table";
import { getMockPayments } from "@/lib/mock-data";

export default function PaymentsPage() {
  const payments = getMockPayments();

  return (
    <>
      <Topbar title="Payments" description="Every payment across all products and PSP accounts" />
      <div className="flex-1 overflow-y-auto p-8">
        <PaymentsTable payments={payments} />
      </div>
    </>
  );
}
