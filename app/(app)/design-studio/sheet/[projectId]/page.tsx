import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"
import { Suspense } from "react"
import { notFound } from "next/navigation"

import { PageLayout } from "@/components/layout/page-layout"
import { SelectionSheetClient } from "@/components/design-studio/selection-sheet"
import { getSelectionSheet } from "@/lib/services/design-studio"


interface PageProps {
  params: Promise<{ projectId: string }>
}

async function SelectionSheetPageContent({ params }: PageProps) {
  const { projectId } = await params
  const sheet = await getSelectionSheet(projectId)
  if (!sheet) notFound()

  return (
    <PageLayout
      title={`${sheet.home.lotLabel} — selections`}
      breadcrumbs={[{ label: "Design Studio", href: "/design-studio" }, { label: sheet.home.buyerName }]}
      fullBleed
    >
      <SelectionSheetClient sheet={sheet} />
    </PageLayout>
  )
}

export default function SelectionSheetPage(props: Parameters<typeof SelectionSheetPageContent>[0]) {
  return (
    <Suspense fallback={<PageLoadingSkeleton />}>
      <SelectionSheetPageContent {...props} />
    </Suspense>
  )
}
