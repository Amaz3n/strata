import { connection } from "next/server"
import { Suspense } from "react"

import { PageLayout } from "@/components/layout/page-layout"
import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"
import {
  ReleasedOptions,
  ReleasedScope,
  ReleasedSheets,
  ReleasedTruncationNote,
} from "@/components/field/released-documents"
import { getReleasedForHome } from "@/lib/services/released-field-documents"

async function ReleasedPageContent({ params }: { params: Promise<{ id: string }> }) {
  await connection()
  const { id } = await params
  const released = await getReleasedForHome(id)

  return (
    <PageLayout title="Released for this home" breadcrumbs={[{ label: "Project" }, { label: "Released" }]}>
      <div className="desk-rise flex flex-col">
        {released.truncated && <ReleasedTruncationNote />}
        <ReleasedSheets sheets={released.sheets} />
        <ReleasedOptions options={released.options} />
        <ReleasedScope scope={released.scope} showCompany />
      </div>
    </PageLayout>
  )
}

export default function ReleasedPage(props: Parameters<typeof ReleasedPageContent>[0]) {
  return (
    <Suspense fallback={<PageLoadingSkeleton />}>
      <ReleasedPageContent {...props} />
    </Suspense>
  )
}
