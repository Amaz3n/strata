import { guardWorkspaceDesk } from "@/lib/services/workspace-surface";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton";
import { WarrantyAccounting } from "@/components/books/warranty-accounting";
import { PageLayout } from "@/components/layout/page-layout";
import { getBooksUiAccess } from "@/lib/services/books/ui-access";

async function WarrantyAccountingContent() {
  await connection();
  await guardWorkspaceDesk("warranty");
  if (!(await getBooksUiAccess()).adjust) notFound();
  return (
    <PageLayout
      title="Warranty accounting"
      breadcrumbs={[
        { label: "Warranty", href: "/warranty" },
        { label: "Cost accounting" },
      ]}
    >
      <WarrantyAccounting />
    </PageLayout>
  );
}

export default function WarrantyAccountingPage() {
  return (
    <Suspense fallback={<PageLayout
      title="Warranty accounting"
      breadcrumbs={[
        { label: "Warranty", href: "/warranty" },
        { label: "Cost accounting" },
      ]}
    ><PageLoadingSkeleton /></PageLayout>}>
      <WarrantyAccountingContent />
    </Suspense>
  );
}
