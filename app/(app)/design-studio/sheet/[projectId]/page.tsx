import { notFound } from "next/navigation"

import { PageLayout } from "@/components/layout/page-layout"
import { SelectionSheetClient } from "@/components/design-studio/selection-sheet"
import { getSelectionSheet } from "@/lib/services/design-studio"

export const dynamic = "force-dynamic"

interface PageProps {
  params: Promise<{ projectId: string }>
}

export default async function SelectionSheetPage({ params }: PageProps) {
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
