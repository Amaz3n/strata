import { connection } from "next/server"
import { Suspense } from "react"
import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"
import { notFound } from "next/navigation";
import { BooksRegisters } from "@/components/books/books-registers";
import { LandAcquisition } from "@/components/books/land-acquisition";
import { PageLayout } from "@/components/layout/page-layout";
import { getBooksUiAccess } from "@/lib/services/books/ui-access";

async function AssetsPageContent() {
  await connection()
  const access = await getBooksUiAccess();
  if (!access.adjust) notFound();
  return (
    <PageLayout
      title="Assets & loans"
      breadcrumbs={[{ label: "Books" }, { label: "Assets & loans" }]}
    >
      <div className="space-y-6">
        <BooksRegisters />
        <section className="space-y-3 border p-5">
          <h2 className="text-sm font-semibold">Land acquisitions</h2>
          <p className="text-sm text-muted-foreground">
            Record acquired lots and their funding. Manage each home's inventory
            accounting from its project budget.
          </p>
          <LandAcquisition />
        </section>
      </div>
    </PageLayout>
  );
}

export default function AssetsPage() {
  return (
    <Suspense fallback={<PageLayout title="Assets & loans" breadcrumbs={[{ label: "Books" }, { label: "Assets & loans" }]}><PageLoadingSkeleton /></PageLayout>}>
      <AssetsPageContent />
    </Suspense>
  )
}
