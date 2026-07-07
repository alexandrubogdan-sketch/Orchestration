import { Topbar } from "@/components/layout/topbar";
import { CustomersTable } from "@/components/customers/customers-table";
import { getMockCustomers } from "@/lib/mock-data";

export default function CustomersPage() {
  const customers = getMockCustomers();

  return (
    <>
      <Topbar
        title="Customers"
        description="Every customer that has attempted a payment, with their saved payment methods"
      />
      <div className="flex-1 overflow-y-auto p-8">
        <CustomersTable customers={customers} />
      </div>
    </>
  );
}
