import { connection } from "next/server"
import { Suspense } from "react"
import { notFound } from "next/navigation"
import { PageLayout } from "@/components/layout/page-layout"
import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"
import { CostAllocationRegister } from "@/components/books/cost-allocation-register"
import { getBooksUiAccess } from "@/lib/services/books/ui-access"
import { requireBooksWorkspaceEnabled } from "@/lib/services/books/module"
import { getCostAllocationRegister } from "@/lib/services/books/cost-allocations"

async function Content() {
  await connection()
  const [access] = await Promise.all([getBooksUiAccess(), requireBooksWorkspaceEnabled()])
  if (!access.read) notFound()
  const register = await getCostAllocationRegister()
  return (
    <PageLayout title="Cost allocations" breadcrumbs={[{ label: "Books" }, { label: "Cost allocations" }]}>
      <CostAllocationRegister register={register} />
    </PageLayout>
  )
}

export default function Page() {
  return (
    <Suspense fallback={<PageLayout title="Cost allocations"><PageLoadingSkeleton /></PageLayout>}>
      <Content />
    </Suspense>
  )
}
