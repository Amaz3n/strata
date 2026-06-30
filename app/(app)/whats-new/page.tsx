import { PageLayout } from "@/components/layout/page-layout"
import { ReleaseNotesPage } from "@/components/release-notes/release-notes-page"
import { getReleaseNotesOverview } from "@/lib/services/release-notes"

export const dynamic = "force-dynamic"

export default async function WhatsNewPage() {
  const { notes } = await getReleaseNotesOverview()

  return (
    <PageLayout title="What's New">
      <ReleaseNotesPage notes={notes} />
    </PageLayout>
  )
}
