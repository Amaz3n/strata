import { connection } from "next/server"
import { Suspense } from "react"
import { notFound } from "next/navigation"
import { PageLayout } from "@/components/layout/page-layout"
import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"
import { OwnedInventoryDesk } from "@/components/books/owned-inventory-desk"
import { getBooksUiAccess } from "@/lib/services/books/ui-access"
import { requireBooksWorkspaceEnabled } from "@/lib/services/books/module"
import { getOwnedInventoryDesk } from "@/lib/services/books/inventory"

async function Content() {
  await connection()
  const [access] = await Promise.all([getBooksUiAccess(), requireBooksWorkspaceEnabled()])
  if (!access.read) notFound()
  const desk = await getOwnedInventoryDesk()
  return (
    <PageLayout title="Owned inventory" breadcrumbs={[{ label: "Books" }, { label: "Owned inventory" }]}>
      <OwnedInventoryDesk desk={desk} />
    </PageLayout>
  )
}

export default function Page() {
  return (
    <Suspense fallback={<PageLayout title="Owned inventory"><PageLoadingSkeleton /></PageLayout>}>
      <Content />
    </Suspense>
  )
}
