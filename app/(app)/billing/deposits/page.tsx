import { connection } from "next/server"
import { Suspense } from "react"
import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"
import { notFound } from "next/navigation";
import { CustomerDeposits } from "@/components/books/customer-deposits";
import { PageLayout } from "@/components/layout/page-layout";
import { getBooksUiAccess } from "@/lib/services/books/ui-access";

async function CustomerDepositsPageContent() {
  await connection()
  if (!(await getBooksUiAccess()).adjust) notFound();
  return (
    <PageLayout
      title="Customer deposits"
      breadcrumbs={[
        { label: "Billing", href: "/billing" },
        { label: "Customer deposits" },
      ]}
    >
      <CustomerDeposits />
    </PageLayout>
  );
}

export default function CustomerDepositsPage() {
  return (
    <Suspense fallback={<PageLayout title="Customer deposits" breadcrumbs={[{ label: "Billing", href: "/billing" }, { label: "Customer deposits" }]}><PageLoadingSkeleton /></PageLayout>}>
      <CustomerDepositsPageContent />
    </Suspense>
  )
}
