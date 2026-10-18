import { connection } from "next/server"
import { Suspense } from "react"
import { notFound } from "next/navigation"
import { PageLayout } from "@/components/layout/page-layout"
import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"
import { RevenuePolicyRegister } from "@/components/books/revenue-policy-register"
import { getBooksUiAccess } from "@/lib/services/books/ui-access"
import { requireBooksWorkspaceEnabled } from "@/lib/services/books/module"
import { getRevenuePolicyRegister } from "@/lib/services/books/revenue-policies"

async function Content() {
  await connection()
  const [access] = await Promise.all([getBooksUiAccess(), requireBooksWorkspaceEnabled()])
  if (!access.read) notFound()
  const register = await getRevenuePolicyRegister()
  return (
    <PageLayout title="Revenue policies" breadcrumbs={[{ label: "Books" }, { label: "Revenue policies" }]}>
      <RevenuePolicyRegister register={register} />
    </PageLayout>
  )
}

export default function Page() {
  return (
    <Suspense fallback={<PageLayout title="Revenue policies"><PageLoadingSkeleton /></PageLayout>}>
      <Content />
    </Suspense>
  )
}
