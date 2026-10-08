import { connection } from "next/server"
import { Suspense } from "react"
import { notFound } from "next/navigation"
import { PageLayout } from "@/components/layout/page-layout"
import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"
import { LegalEntityWorkspace } from "@/components/books/legal-entity-workspace"
import { getBooksUiAccess } from "@/lib/services/books/ui-access"
import { requireBooksWorkspaceEnabled } from "@/lib/services/books/module"
import { getIntercompanyReconciliation, getLegalEntityWorkspace } from "@/lib/services/books/legal-entities"
import { todayIsoDateOnly } from "@/lib/services/reports/dates"

async function Content() {
  await connection()
  const [access] = await Promise.all([getBooksUiAccess(), requireBooksWorkspaceEnabled()])
  if (!access.read) notFound()
  const [workspace, reconciliation] = await Promise.all([getLegalEntityWorkspace(), getIntercompanyReconciliation(todayIsoDateOnly())])
  return (
    <PageLayout title="Companies" breadcrumbs={[{ label: "Books" }, { label: "Companies" }]}>
      <LegalEntityWorkspace workspace={workspace} reconciliation={reconciliation} />
    </PageLayout>
  )
}

export default function Page() {
  return (
    <Suspense fallback={<PageLayout title="Companies"><PageLoadingSkeleton /></PageLayout>}>
      <Content />
    </Suspense>
  )
}
